use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use anyhow::Result;
use audiopus::coder::Encoder as OpusEncoder;
use base64::Engine;
use clap::Parser;
use futures::prelude::*;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};

use tsclientlib::audio::AudioHandler;
use tsclientlib::events::Event as BookEvent;
use tsclientlib::messages::c2s::OutSendTextMessagePart;
use tsclientlib::prelude::*;
use tsclientlib::{
	data, ChannelId, ClientId, Connection, DisconnectOptions, MessageHandle, MessageTarget,
	StreamItem, TextMessageTargetMode,
};
use tsproto_packets::packets::{AudioData, CodecType, OutAudio};

/// 20ms frames at 48kHz, which is what TeamSpeak's Opus voice codec expects.
const FRAME_SAMPLES: usize = 960;
const OUT_CHANNELS: usize = 2;

#[derive(Parser, Debug)]
#[command(author, about = "One-shot bridge: connects to a real TeamSpeak server and reports events as JSON lines on stdout")]
struct Args {
	/// Server address, e.g. "192.168.178.108" or "192.168.178.108:9987"
	#[arg(short, long)]
	address: String,
	/// Nickname to use on the server
	#[arg(short, long, default_value = "Browser User")]
	nickname: String,
}

#[derive(Serialize)]
struct ChannelInfo {
	id: u64,
	parent: u64,
	order: u64,
	name: String,
}

#[derive(Serialize)]
struct ClientInfo {
	id: u16,
	channel: u64,
	name: String,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Event {
	#[serde(rename = "connected")]
	Connected { welcome_message: String },
	#[serde(rename = "channels")]
	Channels { channels: Vec<ChannelInfo>, clients: Vec<ClientInfo> },
	#[serde(rename = "chatMessage")]
	ChatMessage { from: String, message: String },
	#[serde(rename = "serverMessage")]
	ServerMessage { from: String, message: String },
	/// A direct (whisper) message. `partner_id`/`partner_name` always identify
	/// the *other* side of the conversation, regardless of who sent it, so the
	/// frontend can group messages into one thread per partner.
	#[serde(rename = "privateMessage")]
	PrivateMessage { partner_id: u16, partner_name: String, from_self: bool, message: String },
	/// Mixed, decoded PCM audio ready to play: 16-bit signed little-endian,
	/// stereo, 48kHz, base64-encoded.
	#[serde(rename = "audioOut")]
	AudioOut { pcm: String },
	/// Ids of clients currently detected as talking.
	#[serde(rename = "talkers")]
	Talkers { clients: Vec<u16> },
	#[serde(rename = "disconnected")]
	Disconnected { reason: String },
	#[serde(rename = "error")]
	Error { message: String },
}

fn emit(event: &Event) {
	println!("{}", serde_json::to_string(event).unwrap());
}

/// `Channel::order` is not a plain position, it's the id of the preceding
/// sibling channel (0 = first child of its parent) - effectively a linked
/// list per parent. This resolves that into a plain 0-based sequence index
/// per parent, so the frontend can just sort by it.
fn resolve_order(channels: &[&data::Channel]) -> HashMap<u64, u64> {
	let mut by_parent: HashMap<u64, Vec<&data::Channel>> = HashMap::new();
	for ch in channels {
		by_parent.entry(ch.parent.0).or_default().push(ch);
	}

	let mut result = HashMap::new();
	for (_, mut remaining) in by_parent {
		let mut prev_id = 0u64;
		let mut index = 0u64;
		while !remaining.is_empty() {
			match remaining.iter().position(|ch| ch.order.0 == prev_id) {
				Some(pos) => {
					let ch = remaining.remove(pos);
					result.insert(ch.id.0, index);
					index += 1;
					prev_id = ch.id.0;
				}
				// Broken/incomplete chain: dump the rest rather than loop forever.
				None => {
					for ch in remaining.drain(..) {
						result.insert(ch.id.0, index);
						index += 1;
					}
				}
			}
		}
	}
	result
}

fn snapshot(con: &data::Connection) -> Event {
	let channel_refs: Vec<&data::Channel> = con.channels.values().collect();
	let order = resolve_order(&channel_refs);

	let channels = channel_refs
		.iter()
		.map(|ch| ChannelInfo {
			id: ch.id.0,
			parent: ch.parent.0,
			order: *order.get(&ch.id.0).unwrap_or(&0),
			name: ch.name.clone(),
		})
		.collect();
	let clients = con
		.clients
		.values()
		.map(|c| ClientInfo { id: c.id.0, channel: c.channel.0, name: c.name.clone() })
		.collect();
	Event::Channels { channels, clients }
}

#[tokio::main]
async fn main() {
	let args = Args::parse();
	if let Err(e) = run(args).await {
		emit(&Event::Error { message: e.to_string() });
	}
}

async fn run(args: Args) -> Result<()> {
	// stdout is a strict newline-delimited-JSON channel for the gateway to parse;
	// all diagnostic logging must go to stderr instead.
	tracing_subscriber::fmt().with_env_filter("warn").with_writer(std::io::stderr).init();

	let con_config = Connection::build(args.address).name(args.nickname);

	let mut con = con_config.connect()?;

	// Wait for the initial book events (means we're logged in and have server state)
	let r = con
		.events()
		.try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))))
		.next()
		.await;
	if let Some(r) = r {
		r?;
	}

	let welcome_message = con.get_state()?.server.welcome_message.clone();
	emit(&Event::Connected { welcome_message });

	// Subscribe to all channels so we actually receive the full channel/client list.
	con.get_state()?.server.set_subscribed(true).send(&mut con)?;

	// Give the server a moment to send the channel/client list, then emit a
	// snapshot. Further snapshots are emitted below whenever book state changes.
	{
		let mut events = con.events().try_filter(|_| future::ready(false));
		tokio::select! {
			_ = tokio::time::sleep(tokio::time::Duration::from_millis(800)) => {}
			_ = events.next() => {}
		}
	}
	emit(&snapshot(con.get_state()?));

	// Main loop: relay book updates as fresh snapshots, watch stdin for a
	// "disconnect" command, watch the connection for the server hanging up.
	let mut stdin_lines = BufReader::new(tokio::io::stdin()).lines();

	let opus_encoder = OpusEncoder::new(
		audiopus::SampleRate::Hz48000,
		audiopus::Channels::Mono,
		audiopus::Application::Voip,
	)?;
	let mut audio_handler = AudioHandler::<ClientId>::new();
	let mut talking: HashSet<u16> = HashSet::new();
	let mut audio_ticker = tokio::time::interval(tokio::time::Duration::from_millis(20));
	// Commands sent via `send()` fail silently if the server rejects them (e.g.
	// missing permission) - no reply is sent back without a return code. Using
	// `send_with_result()` for text messages gets us a `MessageResult` event we
	// can surface as a visible error instead of the message just vanishing.
	let mut pending_messages: HashMap<MessageHandle, String> = HashMap::new();

	enum LoopOutcome {
		StdinLine(std::io::Result<Option<String>>),
		ConEvent(Option<Result<StreamItem, tsclientlib::Error>>),
		AudioTick,
	}

	loop {
		let mut events = con.events();
		let outcome = tokio::select! {
			line = stdin_lines.next_line() => LoopOutcome::StdinLine(line),
			ev = events.next() => LoopOutcome::ConEvent(ev),
			_ = audio_ticker.tick() => LoopOutcome::AudioTick,
		};
		drop(events);

		match outcome {
			LoopOutcome::StdinLine(line) => match line {
				Ok(Some(l)) => {
					let l = l.trim();
					if l == "disconnect" {
						con.disconnect(DisconnectOptions::new())?;
						con.events().for_each(|_| future::ready(())).await;
						emit(&Event::Disconnected { reason: "client requested".into() });
						break;
					} else if let Some(rest) = l.strip_prefix("switch ") {
						match rest.trim().parse::<u64>() {
							Ok(id) => {
								let part = {
									let state = con.get_state()?;
									let own = &state.clients[&state.own_client];
									own.client_move(ChannelId(id))
								};
								if let Err(e) = part.send(&mut con) {
									emit(&Event::Error { message: e.to_string() });
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid channel id: {rest}") }),
						}
					} else if let Some(message) = l.strip_prefix("chat ") {
						let part = OutSendTextMessagePart {
							target: TextMessageTargetMode::Channel,
							target_client_id: None,
							message: Cow::Borrowed(message),
						};
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_messages.insert(handle, "Channel message".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
						// No local echo here: the server reflects our own channel
						// messages back to us too, so it arrives via the normal
						// BookEvents/Event::Message path like anyone else's.
					} else if let Some(message) = l.strip_prefix("serverchat ") {
						let part = OutSendTextMessagePart {
							target: TextMessageTargetMode::Server,
							target_client_id: None,
							message: Cow::Borrowed(message),
						};
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_messages.insert(handle, "Server message".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
						// Same as channel chat: the server echoes this back to us too.
					} else if let Some(rest) = l.strip_prefix("pm ") {
						match rest.trim().split_once(' ') {
							Some((id, message)) => match id.parse::<u16>() {
								Ok(id) => {
									let part = OutSendTextMessagePart {
										target: TextMessageTargetMode::Client,
										target_client_id: Some(ClientId(id)),
										message: Cow::Borrowed(message),
									};
									match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Private message".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									}
									// Same as channel chat: the server echoes this back to
									// us via BookEvents/Event::Message, no local echo needed.
								}
								Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id}") }),
							},
							None => emit(&Event::Error { message: "Malformed pm command".into() }),
						}
					} else if let Some(b64) = l.strip_prefix("audio ") {
						match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
							Ok(bytes) => {
								let samples: Vec<f32> = bytes
									.chunks_exact(2)
									.map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
									.collect();
								if samples.len() == FRAME_SAMPLES {
									let mut opus_output = [0u8; 1275];
									match opus_encoder.encode_float(&samples, &mut opus_output) {
										Ok(len) => {
											let packet = OutAudio::new(&AudioData::C2S {
												id: 0,
												codec: CodecType::OpusVoice,
												data: &opus_output[..len],
											});
											if let Err(e) = con.send_audio(packet) {
												emit(&Event::Error { message: e.to_string() });
											}
										}
										Err(e) => emit(&Event::Error { message: format!("Opus encode failed: {e}") }),
									}
								}
							}
							Err(e) => emit(&Event::Error { message: format!("Invalid audio payload: {e}") }),
						}
					}
					// unrecognized lines are ignored
				}
				Ok(None) => {
					emit(&Event::Disconnected { reason: "stdin closed".into() });
					break;
				}
				Err(e) => {
					emit(&Event::Error { message: e.to_string() });
					break;
				}
			},
			LoopOutcome::ConEvent(ev) => match ev {
				Some(Ok(StreamItem::BookEvents(events))) => {
					for event in &events {
						if let BookEvent::Message { target, invoker, message } = event {
							match target {
								MessageTarget::Server => {
									emit(&Event::ServerMessage {
										from: invoker.name.clone(),
										message: message.clone(),
									});
								}
								MessageTarget::Channel => {
									emit(&Event::ChatMessage {
										from: invoker.name.clone(),
										message: message.clone(),
									});
								}
								MessageTarget::Client(other_id) => {
									let own_id = con.get_state()?.own_client;
									if invoker.id == own_id {
										let partner_name = con
											.get_state()?
											.clients
											.get(other_id)
											.map(|c| c.name.clone())
											.unwrap_or_default();
										emit(&Event::PrivateMessage {
											partner_id: other_id.0,
											partner_name,
											from_self: true,
											message: message.clone(),
										});
									} else {
										emit(&Event::PrivateMessage {
											partner_id: invoker.id.0,
											partner_name: invoker.name.clone(),
											from_self: false,
											message: message.clone(),
										});
									}
								}
								_ => {}
							}
						}
					}
					emit(&snapshot(con.get_state()?));
				}
				Some(Ok(StreamItem::Audio(packet))) => {
					let from = match packet.data().data() {
						AudioData::S2C { from, .. } => Some(ClientId(*from)),
						AudioData::S2CWhisper { from, .. } => Some(ClientId(*from)),
						_ => None,
					};
					if let Some(from) = from {
						if let Ok(Some(new_talker)) = audio_handler.handle_packet(from, packet) {
							if talking.insert(new_talker.0) {
								emit(&Event::Talkers { clients: talking.iter().copied().collect() });
							}
						}
					}
				}
				Some(Ok(StreamItem::MessageResult(handle, result))) => {
					if let Some(label) = pending_messages.remove(&handle) {
						if let Err(e) = result {
							emit(&Event::Error { message: format!("{label} failed: {e}") });
						}
					}
				}
				Some(Ok(_)) => {}
				Some(Err(e)) => {
					emit(&Event::Disconnected { reason: e.to_string() });
					break;
				}
				None => {
					emit(&Event::Disconnected { reason: "server closed connection".into() });
					break;
				}
			},
			LoopOutcome::AudioTick => {
				if !audio_handler.get_queues().is_empty() {
					let mut buf = vec![0.0f32; FRAME_SAMPLES * OUT_CHANNELS];
					let stopped = audio_handler.fill_buffer(&mut buf);
					let mut talkers_changed = false;
					for id in stopped {
						if talking.remove(&id.0) {
							talkers_changed = true;
						}
					}
					if talkers_changed {
						emit(&Event::Talkers { clients: talking.iter().copied().collect() });
					}

					let mut bytes = Vec::with_capacity(buf.len() * 2);
					for sample in &buf {
						let clamped = sample.clamp(-1.0, 1.0);
						let pcm = (clamped * 32767.0) as i16;
						bytes.extend_from_slice(&pcm.to_le_bytes());
					}
					emit(&Event::AudioOut { pcm: base64::engine::general_purpose::STANDARD.encode(bytes) });
				}
			}
		}
	}

	Ok(())
}
