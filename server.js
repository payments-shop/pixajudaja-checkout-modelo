const http = require('http');
const https = require('https');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

// Tenta carregar o cheerio para um parsing de HTML mais robusto
let cheerio;
try {
  cheerio = require('cheerio');
} catch (e) {
  console.warn('Aviso: Cheerio não encontrado. Usando fallback de Regex para extração do PIX.');
}

// ==================== CONFIGURAÇÕES FIXAS ====================
const CAMPAIGN_ID = '133622'; // ID da sua campanha no ajudaja.com.br
// =============================================================

const PORT = process.env.PORT || 3000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ 
        statusCode: res.statusCode, 
        headers: res.headers, 
        body: data 
      }));
    });
    req.on('error', (err) => {
      console.error('Erro na requisição HTTPS:', err.message);
      reject(err);
    });
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Tempo limite da requisição (timeout) atingido'));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // Configuração de CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Rota do Proxy PIX
  if (pathname === '/proxy/pix' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        console.log('--- Nova requisição PIX recebida ---');
        let params;
        try {
          params = JSON.parse(body);
        } catch (e) {
          console.error('Erro ao parsear JSON do frontend:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'JSON enviado pelo frontend é inválido', details: e.message }));
          return;
        }

        console.log('Parâmetros recebidos:', { 
          campaign_id: CAMPAIGN_ID, 
          payer_name: params.payer_name, 
          amount: params.amount 
        });

        const postData = querystring.stringify({
          campaign_id: CAMPAIGN_ID,
          payer_name: params.payer_name,
          payer_email: params.payer_email || 'nao@informado.com',
          msg: '',
          amount: params.amount,
        });

        console.log('Passo 1: Solicitando pagamento ao ajudaja...');
        const ajudajaResponse = await makeRequest({
          hostname: 'ajudaja.com.br',
          path: '/ajudar/ajax_payment_pix.php',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'Referer': `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': 'https://ajudaja.com.br',
            'Accept': 'application/json, text/javascript, */*; q=0.01'
          },
        }, postData);

        if (ajudajaResponse.statusCode !== 200) {
          console.error('Erro na API do ajudaja. Status:', ajudajaResponse.statusCode, 'Body:', ajudajaResponse.body.substring(0, 200));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Falha na comunicação com o provedor de pagamento', status: ajudajaResponse.statusCode, details: ajudajaResponse.body.substring(0, 200) }));
          return;
        }

        let ajudajaData;
        try {
          ajudajaData = JSON.parse(ajudajaResponse.body);
        } catch (e) {
          console.error('Resposta do ajudaja não é um JSON válido:', ajudajaResponse.body.substring(0, 200));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Resposta inválida do provedor', raw: ajudajaResponse.body.substring(0, 100), details: e.message }));
          return;
        }

        if (ajudajaData.status !== 'ok' || !ajudajaData.url) {
          console.warn('Ajudaja retornou erro ou URL ausente:', JSON.stringify(ajudajaData).substring(0, 200));
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'O provedor recusou a geração do PIX', details: ajudajaData }));
          return;
        }

        console.log('Passo 2: Buscando código PIX na página:', ajudajaData.url);
        const pixPageResponse = await makeRequest({
          hostname: 'ajudaja.com.br',
          path: `/ajudar/${ajudajaData.url}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
          },
        });

        const pixHtml = pixPageResponse.body;
        let pixCode = null;

        // Tenta extrair usando Cheerio (mais robusto)
        if (cheerio) {
          const $ = cheerio.load(pixHtml);
          pixCode = $('input[id^="qr_code_text_"]').val() || $('input[value^="0002"]').val();
        }

        // Fallback para Regex se Cheerio falhar ou não estiver disponível
        if (!pixCode) {
          const match1 = pixHtml.match(/id="qr_code_text_[^"]*".*?value="([^"]+)"/);
          const match2 = pixHtml.match(/value="(0002[^"]+)"/);
          pixCode = (match1 ? match1[1] : null) || (match2 ? match2[1] : null);
        }

        if (!pixCode) {
          console.error('Não foi possível localizar o código PIX no HTML retornado. Início do HTML:', pixHtml.substring(0, 500));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Erro ao extrair o código PIX da página de destino', html_snippet: pixHtml.substring(0, 500) }));
          return;
        }

        console.log('PIX extraído com sucesso!');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, pixCode: pixCode }));

      } catch (err) {
        console.error('Erro crítico no processamento do proxy:', err.message, err.stack);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Erro interno no servidor proxy', message: err.message, stack: err.stack }));
      }
    });
    return;
  }

  // Health check endpoint
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Servir arquivos estáticos
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Fallback para index.html (útil para SPAs)
        fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Arquivo não encontrado');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data2);
          }
        });
      } else {
        console.error('Erro ao ler arquivo estático:', err.message);
        res.writeHead(500);
        res.end('Erro interno ao ler arquivo');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor de Checkout rodando na porta ${PORT}`);
});
