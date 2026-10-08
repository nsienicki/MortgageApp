# Hosting Homebuyer Market Lens on IONOS

The site is a Python web app with its own database, so it needs a server where you can run
programs: an **IONOS VPS or Cloud Server running Ubuntu**. IONOS shared web hosting and
Deploy Now are built for PHP and static sites and can't run it.

## What you need

- **Server:** Linux VPS with Ubuntu 24.04 (22.04 also works). At least **2 GB of RAM**
  and 20 GB of disk. The weekly data refresh peaks around 0.5–1 GB of memory. Data and
  downloads take about 600 MB of disk.
- **A domain** in IONOS, or anywhere you can edit DNS.
- **On your PC:** Windows 10 or 11 (`ssh`, `scp` and `tar` are built in).

## 1. Create the server

1. In the IONOS Cloud Panel, create a Linux VPS with **Ubuntu 24.04**.
2. Add an SSH key while creating it (recommended), or note the root password.
   To make a key on your PC: `ssh-keygen -t ed25519 -f $HOME\.ssh\ionos_ed25519`.
   Then paste the contents of `ionos_ed25519.pub` into IONOS.
3. Note the server's **public IP address**.
4. In the Cloud Panel's firewall settings for the server (Network › Firewall Policies), allow
   incoming **TCP 22** (SSH), **80** (HTTP) and **443** (HTTPS).

## 2. Point your domain at it

In IONOS under **Domains & SSL › your domain › DNS**:

- Set the **A record** for `@` to the server's IP address.
- Optional: add a record for `www`, either an A record with the same IP or a CNAME to `@`.
- If the server has an IPv6 address, add an **AAAA** record too.

DNS changes can take a few minutes to a few hours to take effect. Check with
`nslookup yourdomain.com`.

## 3. Upload the site

From the project folder on your PC, in PowerShell:

```powershell
.\deploy\upload.ps1 -Server root@YOUR.SERVER.IP
# or, with a key:  .\deploy\upload.ps1 -Server root@YOUR.SERVER.IP -KeyFile $HOME\.ssh\ionos_ed25519
```

This sends only the code (about 70 KB). Your local `data/` folder and `.venv` stay on your PC.

## 4. Set up the server (first time only)

```powershell
ssh root@YOUR.SERVER.IP
```

then on the server:

```bash
bash /opt/homebuyer-lens/app/deploy/setup_server.sh yourdomain.com you@example.com
```

The script:

1. installs Python, nginx, Certbot and the firewall
2. creates a dedicated `lens` account with no login
3. installs the Python packages
4. downloads the data and builds the database (a few minutes)
5. starts the site and the weekly refresh
6. configures nginx and the firewall
7. gets a free HTTPS certificate from Let's Encrypt

The email address receives certificate expiry notices. Certificates renew automatically.

If DNS hasn't reached the server yet, the HTTPS step says so and prints the command to run later.

Check the result:

- `https://yourdomain.com`: the site
- `https://yourdomain.com/healthz`: `{"ok": true, ...}` when the site and data are healthy

## Updating the site

Make changes on your PC, test them locally, then run the same upload command:

```powershell
.\deploy\upload.ps1 -Server root@YOUR.SERVER.IP
```

It swaps in the new code, restarts the site and confirms it's back up. The previous version is
kept in `/opt/homebuyer-lens/app.previous`. If the site doesn't come back, the script prints
the rollback command.

## Day to day

| Task | Command (on the server) |
|---|---|
| Watch the site's log | `journalctl -u homebuyer-lens -f` |
| Refresh data now | `systemctl start homebuyer-lens-ingest` (takes a few minutes) |
| See the refresh log | `journalctl -u homebuyer-lens-ingest -n 100` |
| When is the next refresh | `systemctl list-timers homebuyer-lens-ingest` |
| Restart the site | `systemctl restart homebuyer-lens` |

Data refreshes automatically every **Monday around 06:00** (server time). The site stays up
during a refresh, because the new database replaces the old one in a single step.

### Settings

`/etc/homebuyer-lens.env` holds the server's settings. To use metro-level income, add your free
Census key (`CENSUS_API_KEY=...`), then run `systemctl start homebuyer-lens-ingest`.

## Where things live on the server

| Path | What |
|---|---|
| `/opt/homebuyer-lens/app` | the site's code (replaced on each upload) |
| `/opt/homebuyer-lens/venv` | Python packages |
| `/var/lib/homebuyer-lens` | downloads and the database |
| `/etc/homebuyer-lens.env` | settings |
| `/etc/nginx/sites-available/homebuyer-lens` | web server config |

Nothing on the server needs backing up: the code comes from your PC, and the data is
rebuilt from public sources.

## Built-in protections

- **HTTPS everywhere.** HTTP redirects to HTTPS, and the site sends HSTS.
- **Security headers.** A content security policy allows scripts only from this site and cdnjs.
- **Rate limits per visitor:** 20 API requests a second (bursts of 60), and 10 CSV downloads a minute.
  CSV exports over 500,000 rows are refused.
- **Locked-down app account.** The site runs as an account that can't log in or change its own
  code. Only ports 22, 80 and 443 are open.

## Before you announce it

- **Check the data terms of use.** Zillow and Redfin publish their data for research and with
  attribution. Confirm their current terms allow republishing it on a public site, including the
  CSV downloads on the Data page. The footer already credits every source.
- **Set up uptime monitoring.** Point a free monitor (e.g. UptimeRobot) at `/healthz`.
- **Add the Census key** for metro-level income (see Settings above).
