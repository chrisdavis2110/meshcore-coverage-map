require('dotenv').config();
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('./src/app');
const { initializeScheduledTasks } = require('./src/services/maintenance');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Initialize scheduled maintenance tasks
initializeScheduledTasks();

// Try to set up HTTPS
// For Let's Encrypt: copy privkey.pem -> key.pem and fullchain.pem -> cert.pem
const sslKeyPath = path.join(__dirname, 'ssl', 'key.pem');
const sslCertPath = path.join(__dirname, 'ssl', 'cert.pem');

let httpsServer = null;
if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
  try {
    const options = {
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath)
    };

    httpsServer = https.createServer(options, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS server running on port ${HTTPS_PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Accessible on LAN at: https://<your-ip>:${HTTPS_PORT}`);
      console.log(`Note: You'll need to accept the self-signed certificate warning`);
    });
  } catch (error) {
    console.warn('Failed to start HTTPS server:', error.message);
    console.warn('Falling back to HTTP only');
  }
} else {
  console.warn('SSL certificates not found. HTTPS not available.');
  console.warn('To enable HTTPS:');
  console.warn('  1. Create server/ssl/ directory');
  console.warn('  2. Copy your Let\'s Encrypt certificates:');
  console.warn('     cp /etc/letsencrypt/live/coverage.wcmesh.com/privkey.pem server/ssl/key.pem');
  console.warn('     cp /etc/letsencrypt/live/coverage.wcmesh.com/fullchain.pem server/ssl/cert.pem');
  console.warn('  3. Or generate certificates in the ssl/ directory:');
  console.warn('     Run: openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes');
}

// Always start HTTP server (for non-BLE features)
const httpServer = http.createServer(app);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Accessible on LAN at: http://<your-ip>:${PORT}`);
  if (!httpsServer) {
    console.log(`\n⚠️  WARNING: HTTPS not available. Web Bluetooth requires HTTPS.`);
    console.log(`   Generate SSL certificates to enable HTTPS for Bluefy/Web Bluetooth.`);
  }
});
