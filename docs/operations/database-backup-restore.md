# PostgreSQL-Backup-, Restore- und RPO/RTO-Runbook

## Ziel

Dieses Runbook beschreibt die sichere Sicherung und Wiederherstellung der Lulu-Growth-OS-Datenbank. Backups werden als PostgreSQL-Custom-Format mit restriktiven Dateirechten erstellt, per SHA-256 geprüft und nach einer konfigurierbaren Aufbewahrungszeit bereinigt.

## Zielwerte

| Ziel | Vorgabe |
|---|---|
| RPO | 24 Stunden als Mindestziel; für Billing-/Webhook-Daten nach Möglichkeit kürzer |
| RTO | 4 Stunden als Mindestziel für vollständigen Dienstbetrieb |
| Backup-Frequenz | Mindestens täglich; zusätzlich vor größeren Migrationen |
| Aufbewahrung | Standardmäßig 14 Tage; Compliance-Anforderungen können längere Aufbewahrung verlangen |
| Restore-Ziel | Ausschließlich isolierte Restore-Datenbank oder neue Umgebung |

## Backup ausführen

Auf dem Backend-Server müssen `DATABASE_URL`, `pg_dump` und `pg_restore` verfügbar sein. Das Skript liegt unter `scripts/backup-database.sh`.

```bash
cd /var/www/lulu-growth-os/backend
sudo -u lulu-growth env \
  DATABASE_URL='postgresql://…' \
  BACKUP_DIR='/var/backups/lulu-growth-os' \
  RETENTION_DAYS=14 \
  ./scripts/backup-database.sh
```

Das Ergebnis ist nur dann gültig, wenn die Datei erzeugt, die SHA-256-Prüfung geschrieben und `pg_restore --list` erfolgreich ausgeführt wurde. Backups dürfen nicht im Git-Repository oder in öffentlich erreichbaren Webverzeichnissen liegen.

## Restore-Verifikation

Ein Restore-Test darf niemals gegen die Produktionsdatenbank ausgeführt werden. Der Ziel-Connection-String muss auf eine isolierte Datenbank oder einen temporären PostgreSQL-Cluster zeigen. Das Skript verweigert die Ausführung ohne `ALLOW_RESTORE_TEST=1` und verweigert ein Ziel, das identisch zu `DATABASE_URL` ist.

```bash
cd /var/www/lulu-growth-os/backend
sudo -u lulu-growth env \
  DATABASE_URL='postgresql://…/lulu_growth_os' \
  RESTORE_DATABASE_URL='postgresql://…/lulu_growth_os_restore_test' \
  BACKUP_FILE='/var/backups/lulu-growth-os/lulu_growth_os_YYYYMMDDTHHMMSSZ.dump' \
  ALLOW_RESTORE_TEST=1 \
  ./scripts/verify-database-backup.sh
```

Nach einem erfolgreichen Restore müssen mindestens Schema-Migrationen, Workspace-Anzahl, Subscription-Daten, Webhook-Event-Tabelle und ein repräsentativer Read-Query-Test geprüft werden. Der Test wird mit Datum, Backup-SHA, Dauer, RPO, RTO und Ergebnis protokolliert.

## Wiederanlauf

Nach einem vollständigen Ausfall wird zuerst PostgreSQL wiederhergestellt, anschließend werden die Migrationen geprüft, danach das Backend gestartet und `/api/v1/health` sowie `/api/v1/ready` aufgerufen. Erst wenn Readiness erfolgreich ist, darf Nginx den Dienst wieder für Nutzer freigeben. Danach folgen Login, Workspace-Bootstrap, Billing-Status und Webhook-Replay als Smoke-Tests.

## Offener Nachweis

Die Sandbox dieses Audits enthält keine PostgreSQL-Clientwerkzeuge und keine Produktions-DATABASE_URL. Deshalb wurde kein Restore gegen reale Daten ausgeführt. Der Nachweis ist auf dem Server mit einer isolierten Restore-Datenbank durchzuführen und anschließend als Runbook-Protokoll zu archivieren.
