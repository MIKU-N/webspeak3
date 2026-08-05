use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::Result;
use audiopus::coder::Encoder as OpusEncoder;
use base64::Engine;
use clap::Parser;
use futures::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};

use tsclientlib::audio::AudioHandler;
use tsclientlib::events::{Event as BookEvent, PropertyId, PropertyValue};
use tsclientlib::messages::c2s::{OutClientPokeRequestPart, OutSendTextMessagePart};
use tsclientlib::prelude::*;
use tsclientlib::{
	data, ChannelId, ClientId, CodecEncryptionMode, Connection, DisconnectOptions, HostBannerMode,
	HostMessageMode, Identity, InMessage, MaxClients, MessageHandle, MessageTarget, Reason,
	StreamItem, TextMessageTargetMode,
};
use tsproto_packets::packets::{AudioData, CodecType, Direction, Flags, OutAudio, OutCommand, PacketType};

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
	/// Server password, if the server requires one
	#[arg(long)]
	server_password: Option<String>,
	/// Password for the default channel to join, if it's password-protected
	#[arg(long)]
	channel_password: Option<String>,
	/// Channel (name or path, e.g. "Default Channel/Nested") to join on connect,
	/// instead of the server's actual default channel
	#[arg(long)]
	default_channel: Option<String>,
	/// Previously-issued identity (as emitted in the "connected" event's
	/// `identity` field) to reconnect with, so the server sees the same
	/// client UID across sessions. A fresh identity is generated - and
	/// reported back the same way - when omitted or unparseable.
	#[arg(long)]
	identity: Option<String>,
}

#[derive(Serialize)]
struct ChannelInfo {
	id: u64,
	parent: u64,
	order: u64,
	name: String,
	topic: String,
	codec: String,
	max_clients: Option<u16>,
	has_password: bool,
}

#[derive(Serialize)]
struct ClientInfo {
	id: u16,
	channel: u64,
	name: String,
	input_muted: bool,
	output_muted: bool,
	input_hardware_enabled: bool,
	away: bool,
	away_message: String,
	is_channel_commander: bool,
	country: String,
	uid: String,
}

/// Payload for the "serveredit " stdin command - every field is optional so
/// the frontend only needs to send what actually changed. Covers the fields
/// tsclientlib's `Server::edit()` builder exposes named setters for; a few
/// exotic ones (antiflood tuning, quotas, log toggles) have no typed setter
/// upstream and aren't included here.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ServerEditPayload {
	name: Option<String>,
	welcome_message: Option<String>,
	/// `Some("")` clears the password; `None` leaves it unchanged.
	password: Option<String>,
	max_clients: Option<u16>,
	hostmessage: Option<String>,
	/// "none" | "log" | "modal" | "modalquit"
	hostmessage_mode: Option<String>,
	hostbanner_url: Option<String>,
	hostbanner_gfx_url: Option<String>,
	hostbanner_gfx_interval_secs: Option<i64>,
	/// "noadjust" | "adjustignoreaspect" | "adjustkeepaspect"
	hostbanner_mode: Option<String>,
	hostbutton_tooltip: Option<String>,
	hostbutton_url: Option<String>,
	hostbutton_gfx_url: Option<String>,
	nickname: Option<String>,
	phonetic_name: Option<String>,
	/// "perchannel" | "forcedoff" | "forcedon"
	codec_encryption_mode: Option<String>,
}

fn parse_host_message_mode(s: &str) -> Option<HostMessageMode> {
	match s.to_ascii_lowercase().as_str() {
		"none" => Some(HostMessageMode::None),
		"log" => Some(HostMessageMode::Log),
		"modal" => Some(HostMessageMode::Modal),
		"modalquit" => Some(HostMessageMode::Modalquit),
		_ => None,
	}
}

fn parse_host_banner_mode(s: &str) -> Option<HostBannerMode> {
	match s.to_ascii_lowercase().as_str() {
		"noadjust" => Some(HostBannerMode::NoAdjust),
		"adjustignoreaspect" => Some(HostBannerMode::AdjustIgnoreAspect),
		"adjustkeepaspect" => Some(HostBannerMode::AdjustKeepAspect),
		_ => None,
	}
}

fn parse_codec_encryption_mode(s: &str) -> Option<CodecEncryptionMode> {
	match s.to_ascii_lowercase().as_str() {
		"perchannel" => Some(CodecEncryptionMode::PerChannel),
		"forcedoff" => Some(CodecEncryptionMode::ForcedOff),
		"forcedon" => Some(CodecEncryptionMode::ForcedOn),
		_ => None,
	}
}

/// Human-facing entries for the Server tab's log-style notifications
/// (client join/leave/switch, channel group assignment, channel/server
/// changes, own permission errors) - mirrors what the native TS3 client
/// shows inline in the server chat. `rename_all = "camelCase"` covers both
/// the `kind` tag values and field names, so this needs no remapping on the
/// gateway side (unlike the snake_case variants below).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ServerLogEntry {
	ClientJoin { client: String, channel: String },
	ClientLeave { client: String },
	ClientChannelSwitch { client: String, from_channel: String, to_channel: String },
	ClientChannelGroupAssigned { client: String, group: String },
	ChannelCreated { channel: String },
	ChannelDeleted { channel: String },
	ChannelEdited { channel: String },
	ServerEdited,
	PermissionError { action: String },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Event {
	#[serde(rename = "connected")]
	Connected {
		welcome_message: String,
		server_name: String,
		server_max_clients: u16,
		server_version: String,
		server_license: String,
		server_banner_url: String,
		/// Opaque JSON blob the frontend can store and pass back as `--identity`
		/// on a future connection to keep the same client UID.
		identity: String,
	},
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
	/// Someone poked us. Pokes can only be received here - the server doesn't
	/// echo our own outgoing pokes back to us, unlike text messages.
	#[serde(rename = "poke")]
	Poke { from: String, message: String },
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
	/// Server-tab log notification (client join/leave/switch, channel group
	/// assignment, channel/server changes, own permission errors).
	#[serde(rename = "serverLog")]
	ServerLog {
		#[serde(flatten)]
		entry: ServerLogEntry,
	},
	/// Reply to a "clientconninfo <id>" request - live stats for one client's
	/// connection (ping, packet loss, bytes/packets sent+received).
	#[serde(rename = "clientConnectionInfo")]
	ClientConnectionInfo {
		client_id: u16,
		ping_ms: Option<f64>,
		connected_secs: Option<i64>,
		ip: Option<String>,
		packets_sent: u64,
		bytes_sent: u64,
		packets_received: u64,
		bytes_received: u64,
		packet_loss_percent: f32,
	},
	/// Reply to a "serverconninfo" request - aggregate connection stats for
	/// the whole server-side link.
	#[serde(rename = "serverConnectionInfo")]
	ServerConnectionInfo {
		ping_ms: f64,
		connected_secs: i64,
		packet_loss_percent: f32,
		packets_sent_total: u64,
		bytes_sent_total: u64,
		packets_received_total: u64,
		bytes_received_total: u64,
		bandwidth_sent_last_second: u64,
		bandwidth_received_last_second: u64,
	},
	/// Reply to a "serverlog" request - raw lines from the virtual server's
	/// protocol log (distinct from `ServerLog` above, which is the synthesized
	/// client-join/channel-edit/etc. feed for the Server tab).
	#[serde(rename = "serverProtocolLog")]
	ServerProtocolLog { lines: Vec<String> },
}

fn emit(event: &Event) {
	println!("{}", serde_json::to_string(event).unwrap());
}

fn emit_server_log(entry: ServerLogEntry) {
	emit(&Event::ServerLog { entry });
}

/// Translates a single book-state diff into a Server-tab log entry, when it's
/// one of the changes worth surfacing there (client join/leave/switch,
/// channel group assignment, channel/server changes). Most diffs (e.g.
/// per-field client updates like mute state) are intentionally not logged -
/// only the categories the native client's server log shows for these.
fn log_book_event(con: &data::Connection, event: &BookEvent) {
	match event {
		BookEvent::PropertyAdded { id: PropertyId::Client(client_id), .. } => {
			if let Some(client) = con.clients.get(client_id) {
				let channel = con.channels.get(&client.channel).map(|c| c.name.clone()).unwrap_or_default();
				emit_server_log(ServerLogEntry::ClientJoin { client: client.name.clone(), channel });
			}
		}
		BookEvent::PropertyRemoved { id: PropertyId::Client(_), old: PropertyValue::Client(client), .. } => {
			emit_server_log(ServerLogEntry::ClientLeave { client: client.name.clone() });
		}
		BookEvent::PropertyAdded { id: PropertyId::Channel(channel_id), .. } => {
			if let Some(channel) = con.channels.get(channel_id) {
				emit_server_log(ServerLogEntry::ChannelCreated { channel: channel.name.clone() });
			}
		}
		BookEvent::PropertyRemoved { id: PropertyId::Channel(_), old: PropertyValue::Channel(channel), .. } => {
			emit_server_log(ServerLogEntry::ChannelDeleted { channel: channel.name.clone() });
		}
		BookEvent::PropertyChanged { id: PropertyId::ClientChannel(client_id), old: PropertyValue::ChannelId(old_channel), .. } => {
			if let Some(client) = con.clients.get(client_id) {
				let from_channel = con.channels.get(old_channel).map(|c| c.name.clone()).unwrap_or_default();
				let to_channel = con.channels.get(&client.channel).map(|c| c.name.clone()).unwrap_or_default();
				emit_server_log(ServerLogEntry::ClientChannelSwitch {
					client: client.name.clone(),
					from_channel,
					to_channel,
				});
			}
		}
		BookEvent::PropertyChanged { id: PropertyId::ClientChannelGroup(client_id), .. } => {
			if let Some(client) = con.clients.get(client_id) {
				let group =
					con.channel_groups.get(&client.channel_group).map(|g| g.name.clone()).unwrap_or_default();
				emit_server_log(ServerLogEntry::ClientChannelGroupAssigned { client: client.name.clone(), group });
			}
		}
		BookEvent::PropertyChanged {
			id:
				PropertyId::ChannelName(channel_id)
				| PropertyId::ChannelTopic(channel_id)
				| PropertyId::ChannelMaxClients(channel_id)
				| PropertyId::ChannelMaxFamilyClients(channel_id)
				| PropertyId::ChannelHasPassword(channel_id)
				| PropertyId::ChannelNeededTalkPower(channel_id)
				| PropertyId::ChannelCodec(channel_id)
				| PropertyId::ChannelCodecQuality(channel_id)
				| PropertyId::ChannelIsDefault(channel_id)
				| PropertyId::ChannelDeleteDelay(channel_id)
				| PropertyId::ChannelPhoneticName(channel_id)
				| PropertyId::ChannelIsPrivate(channel_id)
				| PropertyId::ChannelForcedSilence(channel_id)
				| PropertyId::ChannelOrder(channel_id)
				| PropertyId::ChannelParent(channel_id),
			..
		} => {
			if let Some(channel) = con.channels.get(channel_id) {
				emit_server_log(ServerLogEntry::ChannelEdited { channel: channel.name.clone() });
			}
		}
		BookEvent::PropertyChanged {
			id:
				PropertyId::ServerName
				| PropertyId::ServerWelcomeMessage
				| PropertyId::ServerHostmessage
				| PropertyId::ServerHostmessageMode
				| PropertyId::ServerHostbannerUrl
				| PropertyId::ServerHostbannerGfxUrl
				| PropertyId::ServerHostbannerGfxInterval
				| PropertyId::ServerHostbannerMode
				| PropertyId::ServerHostbuttonTooltip
				| PropertyId::ServerHostbuttonUrl
				| PropertyId::ServerHostbuttonGfxUrl
				| PropertyId::ServerPhoneticName
				| PropertyId::ServerIcon
				| PropertyId::ServerMaxClients
				| PropertyId::ServerAskForPrivilegekey
				| PropertyId::ServerDefaultServerGroup
				| PropertyId::ServerDefaultChannelGroup
				| PropertyId::ServerCodecEncryptionMode
				| PropertyId::ServerTempChannelDefaultDeleteDelay
				| PropertyId::ServerPrioritySpeakerDimmModificator,
			..
		} => {
			emit_server_log(ServerLogEntry::ServerEdited);
		}
		_ => {}
	}
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
			topic: ch.topic.clone().unwrap_or_default(),
			codec: format!("{:?}", ch.codec),
			max_clients: match ch.max_clients {
				Some(MaxClients::Limited(n)) => Some(n),
				_ => None,
			},
			has_password: ch.has_password.unwrap_or(false),
		})
		.collect();
	let clients = con
		.clients
		.values()
		.map(|c| ClientInfo {
			id: c.id.0,
			channel: c.channel.0,
			name: c.name.clone(),
			input_muted: c.input_muted,
			output_muted: c.output_muted,
			input_hardware_enabled: c.input_hardware_enabled,
			away: c.away_message.is_some(),
			away_message: c.away_message.clone().unwrap_or_default(),
			is_channel_commander: c.is_channel_commander,
			country: c.country_code.clone(),
			uid: c.uid.as_ref().map(|u| u.to_string()).unwrap_or_default(),
		})
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

/// tsclientlib's error `Display` impls mostly fall back to `{:?}` for nested
/// errors (e.g. `Failed to connect to server at "x": [Connect(TsProto(Timeout(..)))]`),
/// which is accurate but not something an end user can act on. Map the cases
/// that come up in practice to plain-language messages instead.
fn friendly_connect_error(address: &str, e: tsclientlib::Error) -> anyhow::Error {
	match &e {
		tsclientlib::Error::ConnectTs(inner) => {
			anyhow::anyhow!("The server rejected the connection: {inner}")
		}
		tsclientlib::Error::InitserverTimeout => anyhow::anyhow!(
			"The server did not finish logging us in within the timeout - please try again"
		),
		_ if e.to_string().contains("Timeout") => anyhow::anyhow!(
			"Could not reach \"{address}\": connection timed out. Check the address/port and that the server is reachable."
		),
		_ => anyhow::anyhow!("Could not connect to \"{address}\": {e}"),
	}
}

async fn run(args: Args) -> Result<()> {
	// stdout is a strict newline-delimited-JSON channel for the gateway to parse;
	// all diagnostic logging must go to stderr instead.
	tracing_subscriber::fmt().with_env_filter("warn").with_writer(std::io::stderr).init();

	let address = args.address.clone();
	let identity = args
		.identity
		.as_deref()
		.and_then(|s| serde_json::from_str::<Identity>(s).ok())
		.unwrap_or_else(Identity::create);
	let identity_str = serde_json::to_string(&identity).unwrap();
	let mut con_config = Connection::build(args.address).name(args.nickname).identity(identity);
	if let Some(pwd) = args.server_password {
		con_config = con_config.password(pwd);
	}
	if let Some(pwd) = args.channel_password {
		con_config = con_config.channel_password(pwd);
	}
	if let Some(channel) = args.default_channel {
		con_config = con_config.channel(channel);
	}

	let mut con = con_config.connect().map_err(|e| friendly_connect_error(&address, e))?;

	// Wait for the initial book events (means we're logged in and have server state).
	// Bounded by a timeout: an unreachable host/port otherwise leaves this waiting
	// forever with no error, since tsclientlib only reports failures through this
	// event stream rather than from `connect()` itself.
	const CONNECT_TIMEOUT_SECS: u64 = 15;
	{
		let mut login_events =
			con.events().try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))));
		match tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), login_events.next()).await {
			Ok(Some(r)) => {
				r.map_err(|e| friendly_connect_error(&address, e))?;
			}
			Ok(None) => {}
			Err(_) => {
				anyhow::bail!(
					"Could not reach \"{address}\": connection timed out after {CONNECT_TIMEOUT_SECS}s. Check the address/port and that the server is reachable."
				);
			}
		}
	}

	let server_state = con.get_state()?;
	let welcome_message = server_state.server.welcome_message.clone();
	let server_name = server_state.server.name.clone();
	let server_max_clients = server_state.server.max_clients;
	let server_version = server_state.server.version.clone();
	let server_license = format!("{:?}", server_state.server.license);
	let server_banner_url = server_state.server.hostbanner_gfx_url.clone();
	emit(&Event::Connected {
		welcome_message,
		server_name,
		server_max_clients,
		server_version,
		server_license,
		server_banner_url,
		identity: identity_str,
	});

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
	// When non-empty, outgoing voice is whispered to just these channels/clients
	// instead of being sent to the current channel - set via the "whisper "
	// stdin command, cleared via "unwhisper".
	let mut whisper_channels: Vec<u64> = Vec::new();
	let mut whisper_clients: Vec<u16> = Vec::new();
	// Set by "clientconninfo"/"serverconninfo" while waiting for the server's
	// reply to land in book state (it arrives async as a later BookEvents
	// batch, not as a direct command result) - checked and emitted below.
	let mut pending_client_conninfo: Option<ClientId> = None;
	let mut pending_server_conninfo = false;
	// Set by "serverlog" while waiting for the notifyserverlog reply, which
	// arrives as a StreamItem::MessageEvent (not a BookEvents batch, since log
	// lines aren't part of the channel/client/server data model).
	let mut pending_server_log = false;

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
					if l == "disconnect" || l.starts_with("disconnect ") {
						let message = l.strip_prefix("disconnect").unwrap_or("").trim();
						let options = if message.is_empty() {
							DisconnectOptions::new()
						} else {
							DisconnectOptions::new().reason(Reason::Clientdisconnect).message(message)
						};
						con.disconnect(options)?;
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
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Channel switch".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
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
					} else if let Some(rest) = l.strip_prefix("poke ") {
						// Unlike chat, a poke's message is optional - a plain poke with no
						// text is a normal thing to send in TeamSpeak.
						let rest = rest.trim();
						let (id, message) = rest.split_once(' ').unwrap_or((rest, ""));
						match id.parse::<u16>() {
							Ok(id) => {
								let part =
									OutClientPokeRequestPart { client_id: ClientId(id), message: Cow::Borrowed(message) };
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Poke".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id}") }),
						}
					} else if l == "away" || l.starts_with("away ") {
						let message = l.strip_prefix("away").unwrap_or("").trim();
						let part = con.get_state()?.client_update().set_away(Some(message));
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if l == "unaway" {
						let part = con.get_state()?.client_update().set_away(None);
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("muteinput ") {
						let part = con.get_state()?.client_update().set_input_muted(rest.trim() == "1");
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("muteoutput ") {
						let part = con.get_state()?.client_update().set_output_muted(rest.trim() == "1");
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("nickname ") {
						let part = con.get_state()?.client_update().set_name(rest.trim());
						if let Err(e) = part.send(&mut con) {
							emit(&Event::Error { message: e.to_string() });
						}
					} else if let Some(rest) = l.strip_prefix("whisper ") {
						// Format: "whisper <channelId,channelId,...>;<clientId,clientId,...>"
						// (either side may be empty, e.g. "whisper 5;" or "whisper ;12,13").
						let mut parts = rest.splitn(2, ';');
						let channels_part = parts.next().unwrap_or("");
						let clients_part = parts.next().unwrap_or("");
						whisper_channels = channels_part.split(',').filter_map(|s| s.trim().parse().ok()).collect();
						whisper_clients = clients_part.split(',').filter_map(|s| s.trim().parse().ok()).collect();
					} else if l == "unwhisper" {
						whisper_channels.clear();
						whisper_clients.clear();
					} else if let Some(rest) = l.strip_prefix("clientconninfo ") {
						match rest.trim().parse::<u16>() {
							Ok(id) => {
								let client_id = ClientId(id);
								let part = con.get_state()?.clients.get(&client_id).map(|c| c.connection_info());
								match part {
									// send_with_result (rather than send) so a missing-permission
									// rejection (e.g. viewing another client's connection info
									// without b_client_view_connection_info) surfaces as a visible
									// error instead of leaving the dialog stuck loading forever.
									Some(part) => match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_client_conninfo = Some(client_id);
											pending_messages.insert(handle, "Connection info".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									},
									None => {
										emit(&Event::Error { message: format!("Unknown client id: {id}") })
									}
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {rest}") }),
						}
					} else if let Some(rest) = l.strip_prefix("kickchannel ") {
						let mut parts = rest.splitn(2, ' ');
						let id_str = parts.next().unwrap_or("");
						let reason = parts.next().unwrap_or("").trim();
						match id_str.trim().parse::<u16>() {
							Ok(id) => {
								let client_id = ClientId(id);
								let part = con.get_state()?.clients.get(&client_id).map(|c| {
									let kick = c.kick(Reason::KickChannel);
									if reason.is_empty() { kick } else { kick.set_reason_message(reason) }
								});
								match part {
									Some(part) => match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Kick from channel".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									},
									None => {
										emit(&Event::Error { message: format!("Unknown client id: {id}") })
									}
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("kickserver ") {
						let mut parts = rest.splitn(2, ' ');
						let id_str = parts.next().unwrap_or("");
						let reason = parts.next().unwrap_or("").trim();
						match id_str.trim().parse::<u16>() {
							Ok(id) => {
								let client_id = ClientId(id);
								let part = con.get_state()?.clients.get(&client_id).map(|c| {
									let kick = c.kick(Reason::KickServer);
									if reason.is_empty() { kick } else { kick.set_reason_message(reason) }
								});
								match part {
									Some(part) => match part.send_with_result(&mut con) {
										Ok(handle) => {
											pending_messages.insert(handle, "Kick from server".into());
										}
										Err(e) => emit(&Event::Error { message: e.to_string() }),
									},
									None => {
										emit(&Event::Error { message: format!("Unknown client id: {id}") })
									}
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("banclient ") {
						// Format: "banclient <id> <seconds> <reason...>" - seconds=0 means permanent.
						// No typed builder exists for banclient, so this is built as a raw command
						// (same approach used for the connection-info requests above).
						let mut parts = rest.splitn(3, ' ');
						let id_str = parts.next().unwrap_or("");
						let seconds_str = parts.next().unwrap_or("0");
						let reason = parts.next().unwrap_or("").trim();
						match id_str.trim().parse::<u16>() {
							Ok(id) => {
								let seconds: u64 = seconds_str.trim().parse().unwrap_or(0);
								let mut packet =
									OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, "banclient");
								packet.write_arg("clid", &id);
								if seconds > 0 {
									packet.write_arg("time", &seconds);
								}
								if !reason.is_empty() {
									packet.write_arg("banreason", &reason);
								}
								match packet.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Ban client".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(_) => emit(&Event::Error { message: format!("Invalid client id: {id_str}") }),
						}
					} else if let Some(rest) = l.strip_prefix("serveredit ") {
						match serde_json::from_str::<ServerEditPayload>(rest) {
							Ok(payload) => {
								let mut part = con.get_state()?.server.edit();
								if let Some(v) = &payload.name {
									part = part.set_name(v);
								}
								if let Some(v) = &payload.welcome_message {
									part = part.set_welcome_message(v);
								}
								if let Some(v) = &payload.password {
									part = part.set_password(if v.is_empty() { None } else { Some(v) });
								}
								if let Some(v) = payload.max_clients {
									part = part.set_max_clients(v);
								}
								if let Some(v) = &payload.hostmessage {
									part = part.set_hostmessage(v);
								}
								if let Some(mode) =
									payload.hostmessage_mode.as_deref().and_then(parse_host_message_mode)
								{
									part = part.set_hostmessage_mode(mode);
								}
								if let Some(v) = &payload.hostbanner_url {
									part = part.set_hostbanner_url(v);
								}
								if let Some(v) = &payload.hostbanner_gfx_url {
									part = part.set_hostbanner_gfx_url(v);
								}
								if let Some(secs) = payload.hostbanner_gfx_interval_secs {
									part = part.set_hostbanner_gfx_interval(time::Duration::seconds(secs));
								}
								if let Some(mode) =
									payload.hostbanner_mode.as_deref().and_then(parse_host_banner_mode)
								{
									part = part.set_hostbanner_mode(mode);
								}
								if let Some(v) = &payload.hostbutton_tooltip {
									part = part.set_hostbutton_tooltip(v);
								}
								if let Some(v) = &payload.hostbutton_url {
									part = part.set_hostbutton_url(v);
								}
								if let Some(v) = &payload.hostbutton_gfx_url {
									part = part.set_hostbutton_gfx_url(v);
								}
								if let Some(v) = &payload.nickname {
									part = part.set_nickname(v);
								}
								if let Some(v) = &payload.phonetic_name {
									part = part.set_phonetic_name(v);
								}
								if let Some(mode) =
									payload.codec_encryption_mode.as_deref().and_then(parse_codec_encryption_mode)
								{
									part = part.set_codec_encryption_mode(mode);
								}
								match part.send_with_result(&mut con) {
									Ok(handle) => {
										pending_messages.insert(handle, "Server edit".into());
									}
									Err(e) => emit(&Event::Error { message: e.to_string() }),
								}
							}
							Err(e) => emit(&Event::Error { message: format!("Invalid server edit payload: {e}") }),
						}
					} else if l == "serverconninfo" {
						let part = con.get_state()?.server.connection_info();
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_server_conninfo = true;
								pending_messages.insert(handle, "Server connection info".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
						}
					} else if l == "serverlog" {
						let part = con.get_state()?.server.log_view().set_lines(200);
						match part.send_with_result(&mut con) {
							Ok(handle) => {
								pending_server_log = true;
								pending_messages.insert(handle, "Server log".into());
							}
							Err(e) => emit(&Event::Error { message: e.to_string() }),
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
											let has_whisper_targets =
												!whisper_channels.is_empty() || !whisper_clients.is_empty();
											let packet = if has_whisper_targets {
												OutAudio::new(&AudioData::C2SWhisper {
													id: 0,
													codec: CodecType::OpusVoice,
													channels: whisper_channels.clone(),
													clients: whisper_clients.clone(),
													data: &opus_output[..len],
												})
											} else {
												OutAudio::new(&AudioData::C2S {
													id: 0,
													codec: CodecType::OpusVoice,
													data: &opus_output[..len],
												})
											};
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
								MessageTarget::Poke(_) => {
									emit(&Event::Poke { from: invoker.name.clone(), message: message.clone() });
								}
							}
						} else {
							log_book_event(con.get_state()?, event);
						}
					}
					if let Some(client_id) = pending_client_conninfo {
						match con.get_state()?.clients.get(&client_id) {
							Some(client) => {
								if let Some(data) = &client.connection_data {
									emit(&Event::ClientConnectionInfo {
										client_id: client_id.0,
										ping_ms: data.ping.map(|d| d.as_seconds_f64() * 1000.0),
										connected_secs: data.connected_time.map(|d| d.whole_seconds()),
										ip: data.client_address.map(|a| a.ip().to_string()),
										packets_sent: data.packets_sent_speech.unwrap_or(0)
											+ data.packets_sent_keepalive.unwrap_or(0)
											+ data.packets_sent_control.unwrap_or(0),
										bytes_sent: data.bytes_sent_speech.unwrap_or(0)
											+ data.bytes_sent_keepalive.unwrap_or(0)
											+ data.bytes_sent_control.unwrap_or(0),
										packets_received: data.packets_received_speech.unwrap_or(0)
											+ data.packets_received_keepalive.unwrap_or(0)
											+ data.packets_received_control.unwrap_or(0),
										bytes_received: data.bytes_received_speech.unwrap_or(0)
											+ data.bytes_received_keepalive.unwrap_or(0)
											+ data.bytes_received_control.unwrap_or(0),
										packet_loss_percent: data.client_to_server_packetloss_total,
									});
									pending_client_conninfo = None;
								}
							}
							None => pending_client_conninfo = None,
						}
					}
					if pending_server_conninfo {
						if let Some(data) = &con.get_state()?.server.connection_data {
							emit(&Event::ServerConnectionInfo {
								ping_ms: data.ping.as_seconds_f64() * 1000.0,
								connected_secs: data.connected_time_total.whole_seconds(),
								packet_loss_percent: data.packetloss_total,
								packets_sent_total: data.packets_sent_total,
								bytes_sent_total: data.bytes_sent_total,
								packets_received_total: data.packets_received_total,
								bytes_received_total: data.bytes_received_total,
								bandwidth_sent_last_second: data.bandwidth_sent_last_second_total,
								bandwidth_received_last_second: data.bandwidth_received_last_second_total,
							});
							pending_server_conninfo = false;
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
							if e.missing_permission.is_some() {
								emit(&Event::ServerLog {
									entry: ServerLogEntry::PermissionError { action: label },
								});
							} else {
								emit(&Event::Error { message: format!("{label} failed: {e}") });
							}
						}
					}
				}
				Some(Ok(StreamItem::MessageEvent(msg))) => {
					if pending_server_log {
						if let InMessage::ServerLog(log) = &msg {
							let lines: Vec<String> = log.iter().map(|part| part.log.clone()).collect();
							emit(&Event::ServerProtocolLog { lines });
							pending_server_log = false;
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
