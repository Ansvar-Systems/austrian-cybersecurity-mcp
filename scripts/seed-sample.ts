/**
 * Seed the CERT.at database with sample guidance documents, advisories, and frameworks.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CERTAT_DB_PATH"] ?? "data/certat.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface FrameworkRow { id: string; name: string; name_en: string; description: string; document_count: number; }

const frameworks: FrameworkRow[] = [
  { id: "itsg", name: "IT-Sicherheitshandbuch (ITSG)", name_en: "Austrian IT Security Handbook", description: "Das IT-Sicherheitshandbuch (ITSG) des Bundeskanzleramts definiert Anforderungen für den sicheren Einsatz von IKT in der österreichischen Bundesverwaltung. Es umfasst Mindeststandards, Sicherheitsmaßnahmen und Implementierungsleitfäden. Grundlage für die NIS-Richtlinienumsetzung in Österreich.", document_count: 30 },
  { id: "mindeststandard", name: "IKT-Mindeststandard", name_en: "ICT Minimum Standard", description: "Der IKT-Mindeststandard des Bundeskanzleramts legt verbindliche Mindestsicherheitsanforderungen für IKT-Systeme der Bundesverwaltung fest. Basiert auf dem NIST Cybersecurity Framework und dem ISO 27001 Standard. Enthält Maßnahmen zu Identifizieren, Schützen, Erkennen, Reagieren und Wiederherstellen.", document_count: 15 },
  { id: "cert-at", name: "CERT.at Warnungen und Empfehlungen", name_en: "CERT.at Warnings and Recommendations", description: "CERT.at (Austrian Computer Emergency Response Team) veröffentlicht Warnungen zu aktuellen Cyberbedrohungen, technische Empfehlungen und Handlungsanleitungen. Zuständig für die koordinierte Reaktion auf Cybersicherheitsvorfälle in Österreich. Nationaler CSIRT gemäß NIS-Richtlinie.", document_count: 400 },
];

const insertFramework = db.prepare("INSERT OR IGNORE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)");
for (const f of frameworks) insertFramework.run(f.id, f.name, f.name_en, f.description, f.document_count);
console.log(`Inserted ${frameworks.length} frameworks`);

interface GuidanceRow { reference: string; title: string; title_en: string | null; date: string; type: string; series: string; summary: string; full_text: string; topics: string; status: string; }

const guidance: GuidanceRow[] = [
  {
    reference: "ITSG-33",
    title: "IT-Sicherheitshandbuch für die österreichische Bundesverwaltung — Mindeststandards",
    title_en: "IT Security Handbook for Austrian Federal Administration — Minimum Standards",
    date: "2023-01-01",
    type: "nis_guide",
    series: "ITSG",
    summary: "ITSG-33 definiert verbindliche IKT-Mindeststandards für Bundesbehörden. Umfasst Maßnahmen zu Netzwerksicherheit, Zugangskontrolle, Kryptographie, Patch-Management und Incident Response. Basiert auf ISO 27001 und NIST CSF.",
    full_text: "ITSG-33 IKT-Mindeststandards Bundesverwaltung. Netzwerksicherheit: Firewall mit Default-Deny-Policy; Netzwerksegmentierung (Trennung Büro-IT, Server, DMZ); verschlüsselte Verbindungen (TLS 1.2+) für externe Dienste; VPN für Remote Access. Zugangskontrolle: Zwei-Faktor-Authentifizierung (2FA) für privilegierte Konten und Remote Access; rollenbasierte Zugriffskontrolle (RBAC); Least-Privilege-Prinzip; regelmäßige Überprüfung der Zugriffsrechte (mindestens jährlich). Kryptographie: AES-256 für Datenverschlüsselung; TLS 1.2 Mindeststandard (TLS 1.3 empfohlen); Zertifikate von vertrauenswürdigen CAs; RSA 2048+ oder EC P-256+. Patch-Management: Kritische Patches innerhalb 7 Tage; Hochkritische (CVSS 9+) innerhalb 48 Stunden; monatliches Patching-Fenster; Inventar aller Systeme. Logging: Zentrale Protokollierung aller sicherheitsrelevanten Ereignisse; Aufbewahrung 3 Jahre; SIEM für kritische Systeme. Incident Response: Dokumentierter IR-Plan; Meldung an CERT.at bei erheblichen Vorfällen; Kontaktdaten NIS-Ansprechpartner hinterlegt.",
    topics: JSON.stringify(["Mindeststandard", "NIS", "Zugangskontrolle", "Kryptographie"]),
    status: "current",
  },
  {
    reference: "CERT.at-TechRep-2023-01",
    title: "Technischer Bericht: Ransomware-Prävention für österreichische Unternehmen",
    title_en: "Technical Report: Ransomware Prevention for Austrian Organisations",
    date: "2023-06-15",
    type: "technical_report",
    series: "CERT.at",
    summary: "CERT.at-Bericht zu Ransomware-Angriffen auf österreichische Organisationen 2022-2023. Analyse der häufigsten Einstiegsvektoren, Empfehlungen zur Prävention und Reaktion. Besonderer Fokus auf KMU und kritische Infrastruktur.",
    full_text: "CERT.at Technischer Bericht Ransomware-Prävention. Häufigste Einstiegsvektoren in Österreich (2022-2023): (1) Phishing-E-Mails mit schädlichen Anhängen (38%); (2) Ausnutzung ungepatchter VPN-Schwachstellen (27%); (3) Kompromittierte RDP-Zugänge (21%); (4) Software Supply Chain (9%). Empfohlene Schutzmaßnahmen: Offline-Backups: 3-2-1-Regel (3 Kopien, 2 verschiedene Medien, 1 off-site); wöchentlicher Restore-Test. E-Mail-Sicherheit: Anti-Phishing-Filter; DMARC, DKIM, SPF konfiguriert; Schulung Mitarbeiter. VPN und Remote Access: Patch-Management; MFA erzwungen; nur genehmigte Clients. Netzwerksegmentierung: Backup-Systeme isoliert; keine laterale Bewegung möglich. EDR/AV: Endpoint Detection and Response; Verhaltensbasierte Erkennung. Incident Response: CERT.at kontaktieren unter +43 1 5056416 78; Meldung bei NIS-Behörde (RTR).",
    topics: JSON.stringify(["Ransomware", "Prävention", "Backup", "Incident Response"]),
    status: "current",
  },
  {
    reference: "ITSG-NIS2-2023",
    title: "Umsetzung der NIS2-Richtlinie in Österreich — Anforderungen und Maßnahmen",
    title_en: "NIS2 Directive Implementation in Austria — Requirements and Measures",
    date: "2023-10-17",
    type: "nis_guide",
    series: "ITSG",
    summary: "Leitfaden zur Umsetzung der NIS2-Richtlinie (Richtlinie (EU) 2022/2555) in Österreich. Gilt für wesentliche und wichtige Einrichtungen. Definiert Mindest-Cybersicherheitsmaßnahmen, Meldepflichten bei Sicherheitsvorfällen und Governance-Anforderungen.",
    full_text: "ITSG-NIS2-2023 NIS2-Umsetzung Österreich. Geltungsbereich: wesentliche Einrichtungen (Energie, Verkehr, Banken, Gesundheit, Trinkwasser, Abwasser, Digitale Infrastruktur, IKT-Dienstleistungen, öffentliche Verwaltung, Raumfahrt) und wichtige Einrichtungen (Post, Abfallwirtschaft, Chemie, Lebensmittel, Hersteller, digitale Anbieter, Forschung). Mindest-Cybersicherheitsmaßnahmen gemäß Art. 21 NIS2: (a) Risikoanalyse und Sicherheitskonzepte; (b) Bewältigung von Sicherheitsvorfällen; (c) Business Continuity; (d) Sicherheit der Lieferkette; (e) Sicherheitsmaßnahmen bei Erwerb, Entwicklung und Wartung; (f) Maßnahmen zur Bewertung der Wirksamkeit; (g) Cyberhygiene und Schulungen; (h) Kryptographie und Verschlüsselung; (i) Personalsicherheit; (j) Zugangskontrolle und Asset-Management; (k) Verwendung von MFA und gesicherten Kommunikationskanälen. Meldepflichten: erhebliche Sicherheitsvorfälle melden an CERT.at (nationales CSIRT) und RTR (zuständige Behörde); Erstmeldung innerhalb 24h; Folgemeldung innerhalb 72h; Abschlussbericht innerhalb 1 Monat.",
    topics: JSON.stringify(["NIS2", "Compliance", "Meldepflicht", "Cybersicherheit"]),
    status: "current",
  },
  {
    reference: "CERT.at-Rec-2024-VPN",
    title: "CERT.at Empfehlung: Sichere VPN-Konfiguration",
    title_en: "CERT.at Recommendation: Secure VPN Configuration",
    date: "2024-01-20",
    type: "recommendation",
    series: "CERT.at",
    summary: "CERT.at-Empfehlung zur sicheren Konfiguration von VPN-Systemen nach aktuellen Angriffswellen auf Ivanti, Fortinet und Cisco VPN-Produkte. Umfasst Patch-Management, MFA-Konfiguration und Monitoring.",
    full_text: "CERT.at Empfehlung Sichere VPN-Konfiguration 2024. Hintergrund: Anhaltende Angriffswelle auf VPN-Produkte (Ivanti Connect Secure CVE-2023-46805/CVE-2024-21887, FortiGate SSL-VPN, Cisco ASA). Sofortmaßnahmen: Patches umgehend einspielen — Ivanti bis 22.01.2024, Fortinet bis sofort; MFA für alle VPN-Zugänge erzwingen; Logs auf verdächtige Verbindungen prüfen. Konfigurationsempfehlungen: TLS 1.2 Mindestversion; starke Cipher-Suites (ECDHE+AES-GCM); Zertifikate von vertrauenswürdigen CAs; Ablauf-Monitoring. Monitoring: Uhrzeit der VPN-Verbindungen; unbekannte Quell-IP-Adressen; mehrere gleichzeitige Sessions eines Nutzers; fehlgeschlagene Auth-Versuche. Im Kompromittierungsfall: CERT.at kontaktieren (+43 1 5056416 78 oder cert@cert.at); Netzwerk isolieren; Forensik-Daten sichern; Passwörter zurücksetzen.",
    topics: JSON.stringify(["VPN", "Konfiguration", "Schwachstelle", "Patch"]),
    status: "current",
  },
  {
    reference: "ITSG-Krypto-2022",
    title: "Kryptographische Anforderungen für die österreichische Bundesverwaltung",
    title_en: "Cryptographic Requirements for Austrian Federal Administration",
    date: "2022-07-01",
    type: "technical_guideline",
    series: "ITSG",
    summary: "Definiert die zulässigen kryptographischen Algorithmen und Parameter für IKT-Systeme der österreichischen Bundesverwaltung. Orientiert sich an BSI TR-02102 und ENISA-Empfehlungen. Enthält Vorgaben zu Schlüssellängen, Hash-Algorithmen, TLS und Zertifikaten.",
    full_text: "ITSG Kryptographische Anforderungen. Symmetrische Verschlüsselung: AES-256 empfohlen; AES-128 akzeptabel; 3DES abgekündigt (bis 2025); RC4 verboten. Authentifizierte Verschlüsselung: AES-256-GCM oder AES-256-CCM bevorzugt. Hash-Algorithmen: SHA-256 Minimum; SHA-384 oder SHA-512 für Hochsicherheitsanwendungen; MD5 und SHA-1 verboten. Asymmetrische Kryptographie: RSA 3072 Bit Minimum (RSA 4096 für > 5 Jahre); ECDSA/ECDH P-256 Minimum; EdDSA Ed25519 akzeptabel. TLS: Version 1.2 Minimum, 1.3 empfohlen; 1.0 und 1.1 verboten; nur ECDHE/DHE-Cipher-Suites (Forward Secrecy); kein RC4, 3DES, EXPORT. Zertifikate: RSA 3072+ oder EC P-256+; SHA-256+; Gültigkeit TLS-Server max. 2 Jahre; OCSP/CRL Monitoring. Schlüsselmanagement: HSM-Einsatz für kritische Schlüssel; Schlüsselrotation: symmetric 1-3 Jahre, RSA/EC 2-5 Jahre.",
    topics: JSON.stringify(["Kryptographie", "AES", "TLS", "Zertifikate"]),
    status: "current",
  },
  {
    reference: "CERT.at-TechRep-2024-OT",
    title: "Cybersicherheit in Operational Technology (OT) — Empfehlungen für kritische Infrastruktur",
    title_en: "Cybersecurity in Operational Technology (OT) — Recommendations for Critical Infrastructure",
    date: "2024-03-01",
    type: "technical_report",
    series: "CERT.at",
    summary: "CERT.at-Bericht zu OT-Cybersicherheit für österreichische kritische Infrastruktur. Behandelt ICS/SCADA-Sicherheit, IT-OT-Segmentierung, Patch-Management in OT-Umgebungen und Incident Response für Industrieanlagen.",
    full_text: "CERT.at OT-Cybersicherheit kritische Infrastruktur. Spezifische OT-Herausforderungen: Legacy-Systeme ohne Patch-Unterstützung; Echtzeit-Anforderungen; physische Sicherheitskonsequenzen; proprietäre Protokolle (Modbus, DNP3, IEC 61850). IT-OT-Segmentierung: strikte Trennung IT und OT-Netzwerk; unidirektionale Datengateways (Data Diodes) für kritische Systeme; keine direkte Internetverbindung für OT; Jump-Server/Remote Access mit MFA und Logging. Patch-Management OT: Risikobasiertes Vorgehen; Tests in Staging-Umgebung; Wartungsfenster koordinieren; virtuelle Patches (IPS) als Übergangslösung. Monitoring: OT-spezifische IDS-Lösungen (Claroty, Dragos, Nozomi); Baseline-Erstellung; Anomalie-Erkennung. Protokollsicherheit: sichere Varianten nutzen (IEC 62351 für IEC 61850); Authentifizierung auf Protokollebene. Incident Response OT: CERT.at + Bundeskriminalamt informieren; OT-Netzwerk isolieren ohne Betrieb zu gefährden; Forensik ohne Produktionsunterbrechung.",
    topics: JSON.stringify(["OT", "ICS", "SCADA", "kritische Infrastruktur"]),
    status: "current",
  },
];

const insertGuidance = db.prepare(`INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const g of guidance) insertGuidance.run(g.reference, g.title, g.title_en, g.date, g.type, g.series, g.summary, g.full_text, g.topics, g.status);
console.log(`Inserted ${guidance.length} guidance documents`);

interface AdvisoryRow { reference: string; title: string; date: string; severity: string; affected_products: string; summary: string; full_text: string; cve_references: string | null; }

const advisories: AdvisoryRow[] = [
  {
    reference: "CERT.at-2024-0023",
    title: "Kritische Schwachstelle in Fortinet FortiOS SSL-VPN — Aktive Ausnutzung",
    date: "2024-02-09",
    severity: "critical",
    affected_products: "Fortinet FortiOS 7.4.0 bis 7.4.2; FortiOS 7.2.0 bis 7.2.6; FortiOS 7.0.0 bis 7.0.13; FortiOS 6.4.x; FortiProxy alle betroffenen Versionen",
    summary: "CERT.at warnt vor aktiver Ausnutzung einer kritischen Schwachstelle (CVE-2024-21762) in Fortinet FortiOS. Ein nicht authentifizierter Angreifer kann beliebigen Code ausführen oder Befehle über speziell gestaltete HTTP-Anfragen ausführen. Sofortiger Patch notwendig.",
    full_text: "CERT.at-2024-0023 Fortinet FortiOS CVE-2024-21762. CVE-2024-21762 (CVSS 9.8 KRITISCH): Out-of-Bounds-Write-Schwachstelle in FortiOS. Nicht authentifizierter Angreifer kann RCE über speziell gestaltete HTTP-Anfragen erzielen. Aktive Ausnutzung von CISA, Fortinet und CERT.at bestätigt. Betroffene Versionen: FortiOS 7.4.0-7.4.2 (Fix: 7.4.3); 7.2.0-7.2.6 (Fix: 7.2.7); 7.0.0-7.0.13 (Fix: 7.0.14); 6.4.x (Fix: 6.4.15); 6.2.x (Fix: 6.2.16). Sofortmaßnahmen: Patches sofort einspielen; falls nicht möglich — SSL-VPN deaktivieren; Logs auf Kompromittierung prüfen (ungewöhnliche Logins, unbekannte User-Accounts, neue Admin-Accounts). IoC: Prüfen auf Webshells in /data/FGFM und /data2/; unbekannte Admin-Konten; externe Zugriffe auf /remote/info. Kontakt CERT.at: +43 1 5056416 78.",
    cve_references: "CVE-2024-21762",
  },
  {
    reference: "CERT.at-2024-0011",
    title: "Ransomware-Angriffe auf österreichische Kommunen — Warnung und Empfehlungen",
    date: "2024-01-25",
    severity: "high",
    affected_products: "Windows Server-Umgebungen ohne MFA; Kommunale IT-Infrastruktur; Active Directory ohne Härtung",
    summary: "CERT.at warnt vor einer Zunahme von Ransomware-Angriffen auf österreichische Gemeinden und Städte. Angreifer nutzen schwache Passwörter und fehlende MFA für RDP-Zugänge. Empfehlung: sofortige Aktivierung von MFA und Überprüfung der Backup-Strategie.",
    full_text: "CERT.at-2024-0011 Ransomware-Angriffe österreichische Kommunen. Beobachtete Angriffsmuster: Kompromittierung über RDP ohne MFA (häufigster Vektor); Passwort-Spray-Angriffe auf Office-365-Konten; Phishing mit Schadsoftware (Qbot, IcedID); Laterale Bewegung über gestohlene Credentials; Datenexfiltration vor Verschlüsselung (BlackBasta, LockBit, Play). Sofortmaßnahmen für Kommunen: RDP aus Internet nicht erreichbar; VPN mit MFA für Remote Access; Passwortstärke erzwingen (min. 12 Zeichen); bekannte kompromittierte Passwörter blocken. Backup: offline Backup prüfen; restore-Fähigkeit testen; Backup-System isoliert vom Produktionsnetzwerk. Monitoring: fehlgeschlagene Login-Versuche alarmieren; ungewöhnliche Admin-Aktivitäten. Kontakt bei Vorfällen: CERT.at +43 1 5056416 78 (24/7); WKO Cyber Versicherung prüfen; Landeskriminalamt informieren.",
    cve_references: null,
  },
  {
    reference: "CERT.at-2023-0189",
    title: "Schwachstellen in Microsoft Exchange Server — Meldepflicht für NIS-Betreiber",
    date: "2023-11-15",
    severity: "high",
    affected_products: "Microsoft Exchange Server 2019 (vor CU13 Nov 2023 SU); Microsoft Exchange Server 2016 (vor CU23 Nov 2023 SU)",
    summary: "CERT.at informiert über kritische Schwachstellen im Patch Tuesday November 2023 für Microsoft Exchange. CVE-2023-36439 ermöglicht RCE durch authentifizierte Angreifer. Für NIS-Betreiber: Meldepflicht bei Ausnutzung. Patches innerhalb 7 Tage gemäß IKT-Mindeststandard.",
    full_text: "CERT.at-2023-0189 Microsoft Exchange November 2023. CVE-2023-36439 (CVSS 8.0 HOCH): Remote Code Execution in Microsoft Exchange Server. Authentifizierter Angreifer im selben Netzwerk kann beliebigen Code auf dem Server ausführen. Kein öffentlicher Exploit bekannt, aber Ausnutzung erwartet. CVE-2023-36050, CVE-2023-36039, CVE-2023-36035 (CVSS 8.0): Spoofing-Schwachstellen in Exchange Server — E-Mail-Absender-Fälschung möglich. Betroffene Versionen: Exchange 2019 CU12 und CU13 ohne Nov 2023 SU; Exchange 2016 CU23 ohne Nov 2023 SU. Patches verfügbar: November 2023 Security Update. Gemäß ITSG-33 Mindeststandard: Patches innerhalb 7 Werktage einspielen. NIS-Betreiber: Ausnutzung melden an CERT.at und RTR. Workaround: Exchange Emergency Mitigation (EEMS) aktivieren.",
    cve_references: "CVE-2023-36439, CVE-2023-36050, CVE-2023-36039, CVE-2023-36035",
  },
];

const insertAdvisory = db.prepare(`INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
for (const a of advisories) insertAdvisory.run(a.reference, a.title, a.date, a.severity, a.affected_products, a.summary, a.full_text, a.cve_references);
console.log(`Inserted ${advisories.length} advisories`);

const gc = (db.prepare("SELECT COUNT(*) as n FROM guidance").get() as { n: number }).n;
const ac = (db.prepare("SELECT COUNT(*) as n FROM advisories").get() as { n: number }).n;
const fc = (db.prepare("SELECT COUNT(*) as n FROM frameworks").get() as { n: number }).n;
console.log(`\nDatabase summary:\n  Guidance: ${gc}\n  Advisories: ${ac}\n  Frameworks: ${fc}\n\nSeed complete.`);
