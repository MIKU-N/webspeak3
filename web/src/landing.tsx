import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./landing.css";

const github = "https://github.com/Moepchi/webspeak3";
const demo = "https://demo.webspeak3.de/";
const client = "https://client.webspeak3.de/";

type Lang = "de" | "en";

const copy = {
  de: {
    nav: ["Features", "Architektur", "Installation"], client: "Client öffnen", hero: ["Direkt im Browser.", "Dein vertrauter Voice-Client, neu gedacht fürs Web. Ohne Installation, ohne Cloud-Zwang – einfach Tab öffnen und verbinden."],
    demo: "Live Demo starten", github: "Auf GitHub ansehen", demoNote: "Die Demo nutzt simulierte Daten – ganz ohne echten Server.", built: "Gebaut mit",
    featureKicker: "ALLES, WAS DU BRAUCHST", featureTitle: "Voice-Chat ohne Kompromisse.", featureIntro: "Die Funktionen, die du von einem Desktop-Client erwartest – in einer modernen, offenen Web-App.",
    features: [["voice", "Voice ohne Umwege", "Opus-Audio mit geringer Latenz, Sprachaktivierung, Gerätewahl und anpassbarer Empfindlichkeit."],["chat", "Chat, der alles bündelt", "Channel-, Server- und private Chats in übersichtlichen Tabs – inklusive Server-Events."],["tree", "Live Channel Tree", "Channels, Nutzer, Status, Länderflaggen und Wechsel in Echtzeit – vertraut, aber fürs Web gedacht."],["whisper", "Gezieltes Whispern", "Sprich mit einzelnen Clients oder ganzen Channels, ohne deinen aktuellen Raum zu stören."],["docker", "Self-hosted by design", "Ein Container für Web-App, Gateway und Connector. Dein Server, deine Regeln, deine Daten."],["mobile", "Unterwegs verbunden", "Eine echte responsive Oberfläche für schmale Displays – nicht nur Desktop in klein."]] as const,
    privacyKicker: "PRIVATSPHÄRE EINGEBAUT", privacyTitle: ["Deine Gespräche.", "Deine Infrastruktur."], privacyText: "WebSpeak3 verbindet sich über dein eigenes Gateway mit deinem TeamSpeak-Server. Keine fremde Cloud, kein Tracking und keine Kontenpflicht.", privacyList: ["Vollständig selbst hostbar", "Quelloffen unter MIT-Lizenz", "Bestehender TS3-Server bleibt unverändert"], control: ["Kontrolle über", "deine Daten"],
    architectureKicker: "UNTER DER HAUBE", architectureTitle: "Vom Tab direkt zum Server.", architectureText: "Eine schlanke Brücke übersetzt WebSocket-Nachrichten in das echte TeamSpeak-Protokoll.",
    screenKicker: "FÜR JEDEN BILDSCHIRM", screenTitle: ["Desktop-Komfort.", "Mobile Freiheit."], screenText: "Dark oder Light, großer Monitor oder Smartphone: WebSpeak3 passt sich an, ohne Kernfunktionen zu verstecken.",
    installKicker: "IN MINUTEN STARTKLAR", installTitle: "Dein Server. Dein WebSpeak3.", installText: "Mit Docker läuft dein eigener Browser-Client in einem einzigen Befehl.", installGuide: "Installationsanleitung", copyCommand: "Befehl kopieren", disclaimer: "Ein unabhängiges Open-Source-Projekt. Nicht mit TeamSpeak Systems GmbH verbunden.", imageAlt: "WebSpeak3 Client im Dark Mode",
  },
  en: {
    nav: ["Features", "Architecture", "Installation"], client: "Open client", hero: ["Right in your browser.", "The voice client you know, reimagined for the web. No installation, no cloud lock-in — just open a tab and connect."],
    demo: "Launch live demo", github: "View on GitHub", demoNote: "The demo uses simulated data — no real server required.", built: "Built with",
    featureKicker: "EVERYTHING YOU NEED", featureTitle: "Voice chat without compromise.", featureIntro: "Everything you expect from a desktop client — inside a modern, open web app.",
    features: [["voice", "Voice without detours", "Low-latency Opus audio, voice activation, device selection and adjustable sensitivity."],["chat", "Chat that brings it together", "Channel, server and private chats in clear tabs — including live server events."],["tree", "Live channel tree", "Channels, users, status icons, country flags and switching in real time — familiar, built for the web."],["whisper", "Targeted whisper", "Talk to individual clients or entire channels without interrupting your current room."],["docker", "Self-hosted by design", "One container for the web app, gateway and connector. Your server, your rules, your data."],["mobile", "Connected on the go", "A truly responsive interface for narrow screens — not merely a shrunken desktop UI."]] as const,
    privacyKicker: "PRIVACY BUILT IN", privacyTitle: ["Your conversations.", "Your infrastructure."], privacyText: "WebSpeak3 connects to your TeamSpeak server through your own gateway. No third-party cloud, no tracking and no account required.", privacyList: ["Fully self-hostable", "Open source under the MIT license", "Your existing TS3 server stays unchanged"], control: ["Control over", "your data"],
    architectureKicker: "UNDER THE HOOD", architectureTitle: "From your tab to the server.", architectureText: "A lean bridge translates WebSocket messages into the real TeamSpeak protocol.",
    screenKicker: "FOR EVERY SCREEN", screenTitle: ["Desktop comfort.", "Mobile freedom."], screenText: "Dark or light, large display or smartphone: WebSpeak3 adapts without hiding core functionality.",
    installKicker: "READY IN MINUTES", installTitle: "Your server. Your WebSpeak3.", installText: "Run your own browser client with a single Docker command.", installGuide: "Installation guide", copyCommand: "Copy command", disclaimer: "An independent open-source project. Not affiliated with TeamSpeak Systems GmbH.", imageAlt: "WebSpeak3 client in dark mode",
  },
} as const;

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    voice: <><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 10.5a7 7 0 0 0 14 0M12 17.5V22M8.5 22h7"/></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></>,
    tree: <><path d="M5 4v16M5 8h6M5 16h6"/><rect x="11" y="5" width="8" height="6" rx="2"/><rect x="11" y="13" width="8" height="6" rx="2"/></>,
    whisper: <><path d="M4 13a8 8 0 0 1 8-8M4 18A13 13 0 0 1 17 5"/><path d="M14 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM12 15v6"/></>,
    docker: <><path d="M3 11h18c0 6-3 9-9 9s-9-3-9-9Z"/><path d="M7 11V7h4v4M11 11V5h4v6M15 11V7h4v4"/></>,
    mobile: <><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Landing() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("webspeak3:landing-language");
    if (saved === "de" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
  });
  const t = copy[lang];

  useEffect(() => {
    localStorage.setItem("webspeak3:landing-language", lang);
    document.documentElement.lang = lang;
    document.title = lang === "de"
      ? "WebSpeak3 – TeamSpeak 3 im Browser | Open Source"
      : "WebSpeak3 – TeamSpeak 3 in Your Browser | Open Source";
  }, [lang]);

  useEffect(() => {
    const elements = document.querySelectorAll<HTMLElement>(".reveal");
    const observer = new IntersectionObserver(
      entries => entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }),
      { threshold: 0.14 },
    );
    elements.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return <div className="landing">
    <div className="ambient ambient-one"></div><div className="ambient ambient-two"></div>
    <header className="nav shell">
      <a className="brand" href="#top"><img src="../logo.png" alt=""/><span>WebSpeak<span>3</span></span></a>
      <nav aria-label={lang === "de" ? "Hauptnavigation" : "Main navigation"}><a href="#features">{t.nav[0]}</a><a href="#architecture">{t.nav[1]}</a><a href="#install">{t.nav[2]}</a></nav>
      <div className="nav-actions"><div className="language-switch" role="group" aria-label={lang === "de" ? "Sprache wählen" : "Choose language"}><button className={lang === "de" ? "active" : ""} onClick={() => setLang("de")} aria-pressed={lang === "de"}>DE</button><button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")} aria-pressed={lang === "en"}>EN</button></div><a className="nav-github" href={github} target="_blank" rel="noreferrer">GitHub <span>↗</span></a></div>
    </header>

    <main id="top">
      <section className="hero shell">
        <div className="hero-copy">
          <div className="eyebrow"><span></span> Open Source · Self-hosted · Beta</div>
          <h1>TeamSpeak 3.<br/><em>{t.hero[0]}</em></h1>
          <p>{t.hero[1]}</p>
          <div className="actions hero-actions"><a className="button primary" href={client}>{t.client} <span>→</span></a><a className="button secondary" href={demo}>{t.demo}</a><a className="button tertiary" href={github} target="_blank" rel="noreferrer">{t.github} ↗</a></div>
          <p className="demo-note"><span>●</span> {t.demoNote}</p>
          <div className="hero-stats"><span><strong>&lt; 30 ms</strong> Voice latency</span><span><strong>100%</strong> self-hosted</span><span><strong>MIT</strong> open source</span></div>
        </div>
        <div className="hero-visual">
          <div className="glow"></div>
          <div className="app-frame"><div className="frame-bar"><i></i><i></i><i></i><span>WebSpeak3 · Demo Server</span></div><img src="../screenshots/webspeak_dark.png" alt={t.imageAlt}/></div>
          <div className="signal-card"><span className="signal">▥</span><div><strong>Voice connected</strong><small>Opus · 48 kHz · 24 ms</small></div><b></b></div>
          <div className="voice-waves" aria-hidden="true">{[1,2,3,4,5,6,7,8,9,10,11,12].map(n=><i key={n}></i>)}</div>
        </div>
      </section>

      <section className="trust shell reveal"><span>{t.built}</span>{["React","TypeScript","Vite","Node.js","Rust","Docker"].map(x=><strong key={x}>{x}</strong>)}</section>

      <section className="section shell reveal" id="features">
        <div className="section-head"><div><span className="kicker">{t.featureKicker}</span><h2>{t.featureTitle}</h2></div><p>{t.featureIntro}</p></div>
        <div className="feature-grid">{t.features.map(([icon,title,description],index)=><article className={`feature-${index + 1}`} key={icon}><span className="card-index">0{index + 1}</span><div className="icon"><Icon name={icon}/></div><h3>{title}</h3><p>{description}</p>{index === 0 && <div className="mini-wave" aria-hidden="true">{[1,2,3,4,5,6,7,8,9].map(n=><i key={n}></i>)}</div>}</article>)}</div>
      </section>

      <section className="privacy reveal"><div className="shell privacy-inner"><div className="privacy-copy"><div className="icon large"><Icon name="lock"/></div><span className="kicker">{t.privacyKicker}</span><h2>{t.privacyTitle[0]}<br/>{t.privacyTitle[1]}</h2><p>{t.privacyText}</p><ul>{t.privacyList.map(item => <li key={item}>{item}</li>)}</ul></div><div className="privacy-card"><div className="orbit orbit-outer"><i></i></div><div className="orbit orbit-inner"><i></i></div><span>SELF-HOSTED</span><strong>100%</strong><small>{t.control[0]}<br/>{t.control[1]}</small></div></div></section>

      <section className="section shell architecture reveal" id="architecture"><div className="section-head centered"><div><span className="kicker">{t.architectureKicker}</span><h2>{t.architectureTitle}</h2></div><p>{t.architectureText}</p></div><div className="flow">{[["Browser","React + Web Audio"],["Gateway","WebSocket · Node.js"],["Rust Connector","tsclientlib + Opus"],["TeamSpeak Server","TS3 / TS6 Protocol"]].map((x,i)=><div className="flow-wrap" style={{"--delay": `${i * 120}ms`} as React.CSSProperties} key={x[0]}><div className="flow-node"><span>0{i+1}</span><strong>{x[0]}</strong><small>{x[1]}</small></div>{i<3&&<div className="flow-arrow" aria-hidden="true"><i></i></div>}</div>)}</div></section>

      <section className="section shell showcase reveal"><div className="showcase-copy"><span className="kicker">{t.screenKicker}</span><h2>{t.screenTitle[0]}<br/>{t.screenTitle[1]}</h2><p>{t.screenText}</p><div className="theme-pills"><span>☾ Dark Mode</span><span>☀ Light Mode</span><span>⌁ Responsive</span></div></div><div className="screens"><img src="../screenshots/webspeak_dark.png" alt="WebSpeak3 Dark Mode"/><img src="../screenshots/webspeak_light.png" alt="WebSpeak3 Light Mode"/></div></section>

      <section className="install shell reveal" id="install"><span className="kicker">{t.installKicker}</span><h2>{t.installTitle}</h2><p>{t.installText}</p><div className="command"><code><i>$</i> docker run -d -p 8080:8080 moepchi/webspeak3:latest</code><button onClick={() => navigator.clipboard?.writeText("docker run -d -p 8080:8080 moepchi/webspeak3:latest")} aria-label={t.copyCommand}>⧉</button></div><div className="actions centered-actions"><a className="button primary" href={`${github}#-installation`} target="_blank" rel="noreferrer">{t.installGuide} <span>→</span></a><a className="text-link" href="https://hub.docker.com/r/moepchi/webspeak3" target="_blank" rel="noreferrer">Docker Hub ↗</a></div></section>
    </main>

    <footer><div className="shell footer-inner"><a className="brand" href="#top"><img src="../logo.png" alt=""/><span>WebSpeak<span>3</span></span></a><p>{t.disclaimer}</p><div><a href={`${github}/blob/main/LICENSE`}>MIT License</a><a href={github}>GitHub</a><a href={`${github}/issues`}>Issues</a></div></div></footer>
  </div>;
}

createRoot(document.getElementById("landing-root")!).render(<StrictMode><Landing /></StrictMode>);
