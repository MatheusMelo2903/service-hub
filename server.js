const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY || '';
const OPENAI_KEY = process.env.OPENAI_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ openai: OPENAI_KEY });
});

app.post('/api/assemblyai/upload', express.raw({type:'*/*', limit:'5gb'}), (req, res) => {
  const opts = { hostname:'api.assemblyai.com', path:'/v2/upload', method:'POST', headers:{'authorization':ASSEMBLYAI_KEY,'content-type':'application/octet-stream','content-length':req.body.length} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.write(req.body); pr.end();
});

app.post('/api/assemblyai/transcript', express.json(), (req, res) => {
  const body = JSON.stringify(req.body);
  const opts = { hostname:'api.assemblyai.com', path:'/v2/transcript', method:'POST', headers:{'authorization':ASSEMBLYAI_KEY,'content-type':'application/json','content-length':Buffer.byteLength(body)} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.write(body); pr.end();
});

app.get('/api/assemblyai/transcript/:id', (req, res) => {
  const opts = { hostname:'api.assemblyai.com', path:'/v2/transcript/'+req.params.id, method:'GET', headers:{'authorization':ASSEMBLYAI_KEY} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.end();
});

app.post('/api/claude/messages', express.json({limit:'10mb'}), (req, res) => {
  if (!ANTHROPIC_KEY) { res.status(500).json({error:'ANTHROPIC_API_KEY ausente no servidor'}); return; }
  const body = JSON.stringify(req.body);
  const opts = { hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','content-type':'application/json','content-length':Buffer.byteLength(body)} };
  const pr = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res.status(r.statusCode).json(JSON.parse(d))}catch(e){res.status(500).json({error:d})} }); });
  pr.on('error', e => res.status(500).json({error:e.message}));
  pr.write(body); pr.end();
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('Service Hub porta ' + PORT));