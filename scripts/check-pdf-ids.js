const { pdftext } = require('./ingest-sb-url');
const fs = require('fs');
const path = process.argv[2];
const buf = fs.readFileSync(path);
const txt = pdftext(buf);
console.log('Length:', txt.length);
const ids = (txt.match(/H\d{4}[-. ]\d{3}/g) || []);
const uniq = [...new Set(ids)];
console.log('Plan IDs found:', JSON.stringify(uniq.slice(0, 20)));
