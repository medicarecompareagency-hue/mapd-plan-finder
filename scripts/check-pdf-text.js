const { pdftext } = require('./ingest-sb-url');
const fs = require('fs');
const path = process.argv[2];
const buf = fs.readFileSync(path);
const txt = pdftext(buf);
const idx = txt.indexOf('H2491');
if (idx >= 0) {
  console.log('H2491 at', idx, ':', txt.slice(Math.max(0, idx - 20), idx + 80));
} else {
  console.log('No H2491 found in text');
}
const matches = txt.match(/H\d{4}[\s\-\.]\d{2,3}/g);
console.log('Plan IDs:', matches ? matches.slice(0, 10) : 'none');
console.log('\nText start:', txt.slice(0, 300));
