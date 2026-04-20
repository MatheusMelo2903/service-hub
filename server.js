const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_KEY = 'ca39770f7b1d490e8330b0cda616948a';

app.use(express.static(path.join(__dirname, 'public')));

// Proxy upload AssemblyAI
app.post('/api/assemblyai/upload', express.raw({type: '*/*', limit: '5gb'}), (req, res) => {
  const options = {
    hostname: 'api.assemblyai.com', path: '/v2/upload', method: 'POST',
    headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream', 'content-length': req.body.length }
  };
  const pr = https.request(options, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res.json(JSON.parse(d))); });
  pr.on('error', e => res.status(500).json({error: e.message}));
  pr.write(req.body); pr.end();
});

// Proxy iniciar transcrição
app.post('/api/assemblyai/transcript', express.json(), (req, res) => {
  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.assemblyai.com', path: '/v2/transcript', method: 'POST',
    headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
  };
  const pr = https.request(options, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res.json(JSON.parse(d))); });
  pr.on('error', e => res.status(500).json({error: e.message}));
  pr.write(body); pr.end();
});

// Proxy status transcrição
app.get('/api/assemblyai/transcript/:id', (req, res) => {
  const options = {
    hostname: 'api.assemblyai.com', path: '/v2/transcript/' + req.params.id, method: 'GET',
    headers: { 'authorization': ASSEMBLYAI_KEY }
  };
  const pr = https.request(options, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res.json(JSON.parse(d))); });
  pr.on('error', e => res.status(500).json({error: e.message}));
  pr.end();
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('Service Hub porta ' + PORT));