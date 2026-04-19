const express = require("express");
const https = require("https");
const axios = require("axios");
const cheerio = require("cheerio");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");

// Carrega variáveis de ambiente
try {
  require("dotenv").config();
} catch (e) {
  console.log("Aviso: dotenv não carregado. Certifique-se de que as variáveis de ambiente estão configuradas.");
}

const app = express();
const PORT = process.env.PORT || 3000;
const CAMPAIGN_ID = process.env.CAMPAIGN_ID || "133622";

// Armazenamento simples de cookies
const cookieStore = {};

// Configuração de CORS para permitir requisições de qualquer origem
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cookie, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204); // Responde a preflight requests
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Configuração da instância Axios para interagir com o site externo
const axiosInstance = axios.create({
  baseURL: "https://ajudaja.com.br",
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://ajudaja.com.br",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "identity", // Desabilita compressão para evitar erros de socket
    "Connection": "close", // Força o fechamento da conexão para evitar socket hang up em retentativas
  },
  withCredentials: true,
  timeout: 30000,
});

// Interceptor de requisição para adicionar cookies do store
axiosInstance.interceptors.request.use(config => {
  const cookies = Object.keys(cookieStore).map(key => `${key}=${cookieStore[key]}`).join("; ");
  if (cookies) {
    config.headers.Cookie = cookies;
  }
  return config;
});

// Interceptor de resposta para salvar cookies no store e lidar com o erro 409
axiosInstance.interceptors.response.use(response => {
  const setCookieHeaders = response.headers["set-cookie"];
  if (setCookieHeaders) {
    setCookieHeaders.forEach(cookieString => {
      const [nameValue] = cookieString.split(";");
      const [name, value] = nameValue.split("=");
      cookieStore[name.trim()] = value;
    });
  }
  return response;
}, async error => {
  const { config, response } = error;
  
  // Se a resposta for 409 e contiver o script de bot detection
  if (response && response.status === 409 && response.data.includes("humans_21909=1")) {
    console.log("Detectado erro 409 de bot detection. Tentando contornar...");
    
    const cookieMatch = response.data.match(/document\.cookie = "(.*?)";/);
    if (cookieMatch && cookieMatch[1]) {
      const cookieString = cookieMatch[1];
      const [name, value] = cookieString.split("=");
      cookieStore[name.trim()] = value;
      console.log(`Cookie \'${name}\' adicionado ao store.`);
    }

    console.log("Retentando a requisição original...");
    // Cria uma nova configuração para a retentativa para garantir que os headers sejam atualizados
    const retryConfig = {
      ...config,
      headers: { ...config.headers }
    };
    return axiosInstance(retryConfig);
  }

  console.error("Erro na requisição Axios:", error.message);
  return Promise.reject(error);
});

/**
 * Gera um Gmail com nome (2 letras) e sobrenome (2 primeiras + última) abreviados
 */
function generateHighlyVariableGmailFromCpf(cpf) {
  const firstNames = ["gabriel", "lucas", "mateus", "felipe", "rafael", "bruno", "thiago", "vinicius", "rodrigo", "andre", "julia", "fernanda", "beatriz", "larissa", "camila", "amanda", "leticia", "mariana", "carolina", "isabela"];
  const lastNames = ["silva", "santos", "oliveira", "souza", "rodrigues", "ferreira", "alves", "pereira", "lima", "gomes", "costa", "ribeiro", "martins", "carvalho", "almeida", "lopes", "soares", "fernandes", "vieira", "barbosa"];

  const cleanCpf = (cpf || "").replace(/\D/g, "");
  const seed = cleanCpf ? parseInt(crypto.createHash("md5").update(cleanCpf).digest("hex").substring(0, 8), 16) : Math.floor(Math.random() * 1000000);
  
  const firstName = firstNames[seed % firstNames.length].substring(0, 2);
  const fullLastName = lastNames[(seed >> 2) % lastNames.length];
  const lastName = fullLastName.substring(0, 2) + fullLastName.slice(-1);
  
  const suffixCpf = cleanCpf.substring(8, 11) || String(Math.floor(Math.random() * 900 + 100));
  const randomNum = Math.floor(Math.random() * 900 + 100);
  const shortNum = Math.floor(Math.random() * 90 + 10);

  const formats = [
    `${firstName}.${lastName}${randomNum}`,
    `${lastName}${firstName}${suffixCpf}`,
    `${firstName}_${lastName}${shortNum}`,
    `${lastName}.${firstName}${randomNum}`,
    `${firstName}${lastName}${suffixCpf}${shortNum}`,
    `${lastName}_${firstName}${randomNum}`,
    `${firstName}${randomNum}${lastName}`,
    `${lastName}${shortNum}${firstName}`,
    `${firstName}.${lastName}.${suffixCpf}`,
    `${lastName}_${firstName}_${shortNum}`,
    `${firstName}${lastName}${randomNum}${shortNum}`
  ];
  
  const selectedFormat = formats[seed % formats.length].replace(/\s/g, ".");
  return `${selectedFormat}@gmail.com`.toLowerCase();
}

// Rota principal para processamento de PIX
app.post("/proxy/pix", async (req, res, next) => {
  console.log("--- Nova requisição PIX recebida ---");
  const { payer_name, payer_email, amount, payer_cpf } = req.body;

  if (!payer_name || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    console.error("Erro: Nome ou valor inválido/ausente.");
    return res.status(400).json({ error: "Nome e valor válidos são obrigatórios." });
  }

  try {
    const finalEmail = (!payer_email || payer_email === "nao@informado.com") 
      ? generateHighlyVariableGmailFromCpf(payer_cpf)
      : payer_email;

    console.log("CPF:", payer_cpf, "| Email Gerado:", finalEmail);

    const postData = new URLSearchParams({
      campaign_id: CAMPAIGN_ID,
      payer_name: payer_name,
      payer_email: finalEmail,
      msg: "",
      amount: parseFloat(amount).toFixed(2),
    }).toString();

    console.log("Enviando POST para ajudaja.com.br/ajudar/ajax_payment_pix.php");
    const ajudajaResponse = await axiosInstance.post("/ajudar/ajax_payment_pix.php", postData, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}`,
      },
    });

    if (ajudajaResponse.status !== 200) {
      return res.status(502).json({ error: "Erro no provedor externo", details: ajudajaResponse.data });
    }

    const ajudajaData = ajudajaResponse.data;
    if (ajudajaData.status !== "ok" || !ajudajaData.url) {
      return res.status(400).json({ error: "Provedor recusou PIX", details: ajudajaData });
    }

    console.log("URL para página PIX:", ajudajaData.url);
    const pixPageResponse = await axiosInstance.get(`/ajudar/${ajudajaData.url}`, {
      headers: { "Referer": `https://ajudaja.com.br/ajudar/?x=${CAMPAIGN_ID}` },
    });

    const $ = cheerio.load(pixPageResponse.data);
    let pixCode = $("input[id^=\"qr_code_text_\"]").val() || 
                  $("input[value^=\"0002\"]").val() || 
                  $("textarea[readonly]").val() || 
                  $("div:contains(\"00020\")").text().match(/00020\d{10,}/)?.[0] || 
                  $("p:contains(\"00020\")").text().match(/00020\d{10,}/)?.[0];

    if (!pixCode) {
      return res.status(500).json({ error: "Erro ao extrair PIX." });
    }

    console.log("Código PIX extraído com sucesso.");
    res.status(200).json({ success: true, pixCode: pixCode });

  } catch (err) {
    console.error("Erro interno na rota /proxy/pix:", err.message);
    res.status(500).json({ error: "Erro interno do servidor", message: err.message });
  }
});

app.get("/health", (req, res) => res.status(200).json({ status: "ok", timestamp: new Date().toISOString() }));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
