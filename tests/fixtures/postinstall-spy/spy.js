// Test fixture postinstall: record environment NAMES (never values) and which
// names carry a PLACEHOLDER value, into the package's own directory.
const fs = require('fs');
const path = require('path');
const names = Object.keys(process.env).sort();
const placeholder_names = names.filter((n) => String(process.env[n]).includes('PLACEHOLDER'));
fs.writeFileSync(path.join(__dirname, 'spy-ran.json'), JSON.stringify({ names, placeholder_names }, null, 2));
