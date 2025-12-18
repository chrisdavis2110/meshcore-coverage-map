# MeshCore Coverage Map - Self-Hosted Server

This is the self-hosted version of the MeshCore Coverage Map, migrated from Cloudflare Pages/Workers to Node.js/Express with PostgreSQL.

## Quick Start

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd meshcore-coverage-map-1
   ```

2. **Set up the server with Docker** (recommended)
   ```bash
   cd server
   cp .env.example .env  # Edit .env with your settings
   npm run docker:dev
   ```
   
   Or from the root directory:
   ```bash
   npm run docker:dev
   ```

3. **Configure MQTT scraper** (optional, for automatic data collection)
   ```bash
   cd ../mqtt-scraper
   cp config.json.example config.json  # Edit config.json with your MQTT credentials
   ```

4. **Start MQTT scraper** (if using Docker)
   ```bash
   cd ../server
   docker-compose up -d mqtt-scraper
   ```

The application will be available at `http://localhost:3000`

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL (v12 or higher) - or use Docker
- npm or yarn
- Docker and Docker Compose (optional, but recommended)

## Setup

### Option 1: Docker (Recommended for Development)

The easiest way to get started is using Docker Compose, which sets up both the database and application:

```bash
cd server
npm run docker:dev
```

This will:
- Build the application container
- Start PostgreSQL database
- Run database migrations automatically
- Start the Node.js server in development mode with hot-reload

The application will be available at `http://localhost:3000`

To run in detached mode (background):

```bash
npm run docker:dev:detached
```

View logs:

```bash
npm run docker:logs
```

Stop containers:

```bash
npm run docker:down
```

### Option 2: Manual Setup

#### 1. Install Dependencies

```bash
cd server
npm install
```

#### 2. Database Setup

Create a PostgreSQL database:

```bash
createdb meshmap
```

Or using psql:

```sql
CREATE DATABASE meshmap;
```

#### 3. Run Migrations

Run the database schema migration:

```bash
npm run migrate
```

Or manually:

```bash
psql -d meshmap -f migrations/001_initial_schema.sql
```

#### 4. Configure Environment

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

Edit `.env` with your actual database credentials and settings. See `.env.example` for all available configuration options and `ENV_CONFIG.md` for detailed documentation.

#### 5. Start the Server

Development mode (with auto-reload):

```bash
npm run dev
```

Production mode:

```bash
npm start
```

The server will start on port 3000 (or the port specified in `.env`).

## Data Migration

If you have existing data from the Cloudflare service, you can migrate it using the migration script:

```bash
node scripts/migrate-data.js --from-slurp
```

This will fetch data from the live Cloudflare service and import it into your PostgreSQL database.

## API Endpoints

The server provides the same API endpoints as the original Cloudflare Workers implementation:

- `GET /get-nodes` - Get all coverage, samples, and repeaters
- `GET /get-coverage` - Get coverage data
- `GET /get-samples?p=<prefix>` - Get samples (optionally filtered by geohash prefix)
- `GET /get-repeaters` - Get all repeaters
- `GET /get-wardrive-coverage` - Get recent coverage geohashes
- `POST /put-sample` - Add/update a sample
- `POST /put-repeater` - Add/update a repeater
- `POST /consolidate?maxAge=<days>` - Consolidate old samples into coverage
- `POST /clean-up?op=<coverage|samples|repeaters>` - Clean up data

## Frontend

The frontend files are served from the `public/` directory. Access the map at:

- `http://localhost:3000/` - Main coverage map
- `http://localhost:3000/addSample.html` - Add sample form
- `http://localhost:3000/addRepeater.html` - Add repeater form
- `http://localhost:3000/wardrive.html` - Wardrive app
- `http://localhost:3000/howto.html` - How-to guide

## Production Deployment

### Docker Production

For production deployment with Docker:

1. Create a `.env` file with production credentials:

```bash
cp .env.example .env
# Edit .env with your production values
```

See `.env.example` for all configuration options.

2. Start with production compose file:

```bash
npm run docker:prod:detached
```

Or manually:

```bash
docker-compose -f docker-compose.prod.yml up -d --build
```

### Manual Production

For production deployment without Docker:

1. Set `NODE_ENV=production` in your `.env` file
2. Use a process manager like PM2:

```bash
npm install -g pm2
pm2 start server.js --name mesh-map
pm2 save
pm2 startup
```

3. Set up a reverse proxy (nginx) - **Recommended for production** (see AWS EC2 Deployment section)
4. Configure SSL/TLS certificates - **Required for HTTPS** (see AWS EC2 Deployment section)
5. Set up database backups

## Differences from Cloudflare Version

- **Database**: Uses PostgreSQL instead of Cloudflare KV
- **Concurrency**: Proper ACID transactions handle concurrent writes
- **No Rate Limits**: No 1 write/key/second limitation
- **Better Queries**: SQL queries are more efficient than KV list operations
- **Transactions**: Consolidate and cleanup operations use database transactions

## Location Validation

By default, location validation is disabled (no distance limit). You can optionally enable it to restrict locations to a specific region.

### Default Behavior

- **Center**: San Jose, CA (37.3382, -121.8863)
- **Max Distance**: 0 (no limit - accepts locations from anywhere)

### Enable Location Validation

To restrict locations to a specific region, configure in your `.env` file (see `.env.example` for details):

```bash
CENTER_POS=37.3382,-121.8863
MAX_DISTANCE_MILES=100
```

Where:
- `CENTER_POS` - Center point in "lat,lon" format
- `MAX_DISTANCE_MILES` - Maximum distance in miles from center (set to 0 to disable)

See `ENV_CONFIG.md` for more details on configuration options.

## Troubleshooting

### Database Connection Issues

Make sure PostgreSQL is running and the credentials in `.env` are correct:

```bash
psql -h localhost -U postgres -d meshmap
```

### Port Already in Use

Change the `PORT` in `.env` or stop the process using port 3000.

### Migration Errors

If migration fails, check:
- Database exists and is accessible
- User has CREATE TABLE permissions
- No conflicting tables exist

### Location Validation Errors

If you get "exceeds max distance" errors:
- By default, distance checking is disabled (MAX_DISTANCE_MILES=0)
- If you've enabled it, set `MAX_DISTANCE_MILES=0` to disable
- Or adjust `CENTER_POS` and `MAX_DISTANCE_MILES` to match your region

## Automated Maintenance

The server includes automated maintenance tasks that run on a schedule:

### Consolidate Task
- **Purpose**: Moves old samples into coverage tiles and archives them
- **Schedule**: Daily at 2 AM (configurable via `CONSOLIDATE_SCHEDULE`)
- **Default Age**: 14 days (2 weeks, configurable via `CONSOLIDATE_MAX_AGE_DAYS`)
- **What it does**:
  - Finds samples older than the configured age
  - Groups them by 6-char geohash (coverage tiles)
  - Merges into coverage table
  - Archives and deletes from samples table

### Cleanup Task
- **Purpose**: Removes stale repeaters and deduplicates
- **Schedule**: Weekly on Sunday at 3 AM (configurable via `CLEANUP_SCHEDULE`)
- **What it does**:
  - Deletes repeaters older than 10 days
  - Deduplicates repeaters at same location (keeps newest)

### Configuration

Configure in your `.env` file (see `.env.example` for all options):

```bash
# Consolidate settings
CONSOLIDATE_ENABLED=true
CONSOLIDATE_SCHEDULE=0 2 * * *  # Daily at 2 AM (cron format)
CONSOLIDATE_MAX_AGE_DAYS=14     # 2 weeks default

# Cleanup settings
CLEANUP_ENABLED=true
CLEANUP_SCHEDULE=0 3 * * 0      # Weekly on Sunday at 3 AM
```

To disable a task, set `CONSOLIDATE_ENABLED=false` or `CLEANUP_ENABLED=false`.

See `ENV_CONFIG.md` for detailed documentation on all configuration options.

### Manual Execution

You can still run maintenance tasks manually via the API:

```bash
# Consolidate (with custom age)
curl -X POST "http://localhost:3000/consolidate?maxAge=7"

# Cleanup repeaters
curl -X POST "http://localhost:3000/clean-up?op=repeaters"
```

Or use the Python script:
```bash
cd mqtt-scraper
python wardrive-maint.py
```

## Test Data Generation

A test script is available to populate the database with sample data for testing:

```bash
npm run test-data
```

Or directly:

```bash
node scripts/generate-test-data.js
```

This will:
- Create 5 repeaters in random locations within 20 miles of the configured center
- Generate 100 samples distributed across those repeaters (within 10 miles of each)
- Interact with the web service API (not directly with the database)

### Configuration

You can customize the test data generation via environment variables:

```bash
SERVICE_HOST=http://localhost:3000 \
CENTER_LAT=37.3382 \
CENTER_LON=-121.8863 \
npm run test-data
```

The script uses the same center position as your server configuration by default.

## MQTT Scraper Setup

The MQTT scraper automatically collects wardrive data and repeater information from MQTT feeds.

### Quick Start with Docker

If you're using Docker Compose, the MQTT scraper is already configured:

1. **Configure MQTT credentials**
   ```bash
   cd mqtt-scraper
   cp config.json.example config.json
   ```

2. **Edit `config.json`** with your MQTT credentials:
   ```json
   {
     "mqtt_mode": "public",
     "mqtt_host": "mqtt-us-v1.letsmesh.net",
     "mqtt_port": 443,
     "mqtt_use_websockets": true,
     "mqtt_use_tls": true,
     "mqtt_use_auth_token": false,
     "mqtt_username": "YOUR_MQTT_USERNAME",
     "mqtt_password": "YOUR_MQTT_PASSWORD",
     "mqtt_topics": [
       "meshcore/SFO/+/packets",
       "meshcore/OAK/+/packets",
       "meshcore/SJC/+/packets"
     ],
     "service_host": "http://app:3000",
     "center_position": [37.4241, -121.9756],
     "valid_dist": 60,
     "channel_hash": "e0",
     "channel_secret": "YOUR_CHANNEL_SECRET_HEX",
     "watched_observers": [
       "OHMC Repeater",
       "Ruth Bader Ginsburg",
       "Nullrouten observer"
     ]
   }
   ```

3. **Start the scraper**
   ```bash
   cd ../server
   docker-compose up -d mqtt-scraper
   ```

4. **View logs**
   ```bash
   docker-compose logs -f mqtt-scraper
   ```

### Manual Setup (Without Docker)

1. **Install Python dependencies**
   ```bash
   cd mqtt-scraper
   pip install paho-mqtt requests haversine cryptography
   ```

2. **Configure**
   ```bash
   cp config.json.example config.json
   # Edit config.json with your settings
   ```

3. **Update service host** (if not using Docker)
   ```json
   {
     "service_host": "http://localhost:3000"
   }
   ```

4. **Run the scraper**
   ```bash
   python wardrive-mqtt.py
   ```

### MQTT Configuration Options

#### Public Mode (letsmesh.net)
- **Host**: `mqtt-us-v1.letsmesh.net` (US) or `mqtt-eu-v1.letsmesh.net` (EU)
- **Port**: 443
- **WebSockets**: true
- **TLS**: true
- **Authentication**: Username/password (or token if `mqtt_use_auth_token: true`)

#### Local Mode (mosquitto)
For local development/testing:
```json
{
  "mqtt_mode": "local",
  "mqtt_host": "localhost",
  "mqtt_port": 1883,
  "mqtt_use_websockets": false,
  "mqtt_use_tls": false,
  "mqtt_use_auth_token": false
}
```

The local mosquitto broker is included in Docker Compose and accessible on:
- Port 1883 (standard MQTT)
- Port 9001 (WebSockets)

### Token-Based Authentication (Optional)

If your MQTT broker requires token authentication:

1. **Enable token auth**
   ```json
   {
     "mqtt_use_auth_token": true,
     "mqtt_token": "your-jwt-token-here"
   }
   ```

2. **Or auto-generate from keys**
   ```json
   {
     "mqtt_use_auth_token": true,
     "mqtt_public_key": "your-64-char-hex-public-key",
     "mqtt_private_key": "your-128-char-hex-private-key"
   }
   ```

The scraper will automatically generate tokens using the `meshcore-decoder` CLI tool.

### Configuration Details

- **service_host**: URL of the coverage map API
  - Docker: `http://app:3000`
  - Manual: `http://localhost:3000`

- **mqtt_topics**: MQTT topics to subscribe to
  - Format: `meshcore/<REGION>/+/packets`
  - Examples: `meshcore/SFO/+/packets`, `meshcore/SJC/+/packets`

- **watched_observers**: List of observer names to monitor (case-sensitive)
  - Only messages from these observers will be processed

- **center_position**: Geographic center for distance validation `[lat, lon]`
- **valid_dist**: Maximum distance in miles from center (0 = no limit)

- **channel_hash** and **channel_secret**: Used to decrypt encrypted channel messages

### Troubleshooting MQTT Scraper

**Connection Issues**
- Verify MQTT broker is accessible
- Check credentials in `config.json`
- For public mode, ensure WebSockets and TLS are enabled
- Check firewall rules for port 443 (public) or 1883 (local)

**No Messages Processed**
- Verify observer names match exactly (case-sensitive)
- Check that topics are correct for your region
- Ensure the service API is running and accessible
- Check scraper logs for connection/subscription errors

**Service API Errors**
- Verify `service_host` is correct
- For Docker: use `http://app:3000`
- For manual: use `http://localhost:3000`
- Check API server logs for errors

## AWS EC2 Deployment

This section covers deploying the application on AWS EC2 with SSL certificates and production hardening.

### Prerequisites

- AWS EC2 instance (Ubuntu 22.04 LTS recommended)
- Domain name pointing to your EC2 instance's public IP
- Security group configured to allow:
  - Port 22 (SSH)
  - Port 80 (HTTP - for Let's Encrypt)
  - Port 443 (HTTPS)
- Root or sudo access to the EC2 instance

### Architecture

For production, we recommend using **Nginx as a reverse proxy**:

```
Internet → Nginx (port 443, SSL) → Express (port 3000, HTTP internal)
```

**Why Nginx?**
- Let's Encrypt certbot works seamlessly with Nginx
- Better performance for static files and SSL termination
- Industry-standard for production deployments
- Handles security headers, rate limiting, and logging
- Simpler than adding multiple Express middleware packages

### Step 1: Install Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### Step 2: Install Let's Encrypt Certificate

```bash
# Install certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain certificate (replace with your domain)
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# Certbot will:
# - Automatically configure Nginx for SSL
# - Set up auto-renewal
# - Redirect HTTP to HTTPS
```

**Auto-renewal** is automatically configured. Test renewal with:
```bash
sudo certbot renew --dry-run
```

### Step 3: Configure Nginx

1. **Copy the configuration template:**
   ```bash
   sudo cp server/nginx/meshmap.conf /etc/nginx/sites-available/meshmap
   ```

2. **Edit the configuration:**
   ```bash
   sudo nano /etc/nginx/sites-available/meshmap
   ```
   
   Update:
   - `server_name` with your domain
   - SSL certificate paths (if certbot didn't auto-configure)
   - Static file paths (if using Nginx for static files)

3. **Enable the site:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/meshmap /etc/nginx/sites-enabled/
   sudo nginx -t  # Test configuration
   sudo systemctl reload nginx
   ```

### Step 4: Configure Firewall

```bash
# Install UFW (if not already installed)
sudo apt install -y ufw

# Allow SSH (important - do this first!)
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable
sudo ufw status
```

**AWS Security Groups:** Also configure in AWS Console:
- Inbound rules: Allow ports 22, 80, 443 from appropriate sources
- Outbound rules: Allow all (default)

### Step 5: Deploy Application

#### Option A: With Docker (Recommended)

1. **Install Docker and Docker Compose:**
   ```bash
   sudo apt install -y docker.io docker-compose
   sudo systemctl enable docker
   sudo usermod -aG docker $USER
   # Log out and back in for group changes
   ```

2. **Clone and configure:**
   ```bash
   git clone <your-repo-url>
   cd meshcore-coverage-map-1/server
   cp .env.example .env
   nano .env  # Configure with production values
   ```

3. **Start services:**
   ```bash
   npm run docker:prod:detached
   ```

#### Option B: Without Docker

1. **Install Node.js and PostgreSQL:**
   ```bash
   # Node.js (using NodeSource)
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs

   # PostgreSQL
   sudo apt install -y postgresql postgresql-contrib
   ```

2. **Set up database:**
   ```bash
   sudo -u postgres psql
   CREATE DATABASE meshmap;
   CREATE USER meshmap WITH PASSWORD 'your_secure_password';
   GRANT ALL PRIVILEGES ON DATABASE meshmap TO meshmap;
   \q
   ```

3. **Configure and run:**
   ```bash
   cd server
   cp .env.example .env
   nano .env  # Configure database and other settings
   npm install
   npm run migrate
   NODE_ENV=production npm start
   ```

4. **Use PM2 for process management:**
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name mesh-map
   pm2 save
   pm2 startup  # Follow instructions to enable on boot
   ```

### Step 6: Verify Deployment

1. **Check Nginx status:**
   ```bash
   sudo systemctl status nginx
   sudo nginx -t
   ```

2. **Check application logs:**
   ```bash
   # Docker
   docker-compose logs -f app

   # PM2
   pm2 logs mesh-map
   ```

3. **Test HTTPS:**
   - Visit `https://your-domain.com`
   - Verify SSL certificate is valid
   - Check browser security indicators

### Production Hardening Checklist

#### ✅ Security Headers (Nginx)
- HSTS (Strict-Transport-Security) - configured in nginx config
- X-Frame-Options - configured
- X-Content-Type-Options - configured
- X-XSS-Protection - configured

#### ✅ Rate Limiting (Nginx)
- API endpoints: 10 requests/second (configurable in nginx config)
- Burst protection: 20 requests

#### ✅ SSL/TLS
- Let's Encrypt certificate installed
- Auto-renewal configured
- Modern TLS protocols (1.2, 1.3)
- Secure cipher suites

#### ✅ Firewall
- UFW configured (ports 22, 80, 443)
- AWS Security Groups configured

#### ✅ Logging
- Nginx access logs: `/var/log/nginx/meshmap_access.log`
- Nginx error logs: `/var/log/nginx/meshmap_error.log`
- Application logs: PM2 or Docker logs

#### ✅ Database Security
- Strong password in `.env` (not committed to git)
- Database only accessible from localhost (default)
- Regular backups recommended

#### ✅ Environment Security
- `.env` file not in git (already in `.gitignore`)
- `NODE_ENV=production` set
- Error messages hidden in production (already configured)

#### ✅ Backup Strategy

**Database Backups:**
```bash
# Manual backup
pg_dump -U meshmap meshmap > backup_$(date +%Y%m%d).sql

# Automated daily backup (add to crontab)
0 2 * * * pg_dump -U meshmap meshmap > /backups/meshmap_$(date +\%Y\%m\%d).sql

# Keep last 30 days
find /backups -name "meshmap_*.sql" -mtime +30 -delete
```

**Application Backups:**
- Code: Git repository (already version controlled)
- Configuration: Backup `.env` file securely
- SSL certificates: Backed up by certbot automatically

### Troubleshooting

**SSL Certificate Issues:**
```bash
# Check certificate status
sudo certbot certificates

# Renew manually
sudo certbot renew

# Check Nginx SSL configuration
sudo nginx -t
```

**Nginx Issues:**
```bash
# Check error logs
sudo tail -f /var/log/nginx/meshmap_error.log

# Test configuration
sudo nginx -t

# Reload configuration
sudo systemctl reload nginx
```

**Application Not Responding:**
```bash
# Check if Express is running
curl http://localhost:3000

# Check Docker containers
docker-compose ps

# Check PM2
pm2 status
pm2 logs mesh-map
```

## License

See LICENSE file in the root directory.

