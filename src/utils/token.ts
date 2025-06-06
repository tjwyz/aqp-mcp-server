import open from "open";
import crypto from "crypto";
import axios from "axios";
import { TransportConfig } from "../utils/transport_config.js";

let cachedToken: string | null = null;
let cachedUserToken: string | null = null;
let tokenExpiresAt = 0; // 用于缓存过期时间戳（秒）
export let tokenWaiters: ((code: string) => void)[] = [];

function base64URLEncode(buffer: Buffer) {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );

  return { code_verifier: verifier, code_challenge: challenge };
}

async function exchangeCodeForToken(code: string, code_verifier: string): Promise<string | null> {
  const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  const clientId = "4b03b804-7fc8-43e2-a31d-263d422949e9";
  const redirectUri = "http://localhost:44330/oauthcallback";
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("scope", `${clientId}/.default`);
  params.append("code", code);
  params.append("redirect_uri", redirectUri);
  params.append("grant_type", "authorization_code");
  params.append("code_verifier", code_verifier); // 🔑 PKCE 的关键参数

  try {
    const response = await axios.post(tokenEndpoint, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const accessToken = response.data.access_token;
    console.log("✅ Access token obtained:", accessToken.slice(0, 20) + "...");
    return accessToken;
  } catch (error: any) {
    console.error("❌ Token exchange failed:", error.response?.data || error);
    return null;
  }
}

export async function getSecreteToken(config: TransportConfig): Promise<string | null> {
  const tenantId = config.stdioConfig?.tenantId || "";
  const clientId = config.stdioConfig?.clientId || "";
  const clientSecret = config.stdioConfig?.clientSecret || "";
  const scope = `${clientId}/.default`;
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && tokenExpiresAt > now + 60) {
    return cachedToken;
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", scope);

  try {
    const response = await axios.post(tokenEndpoint, params);
    const { access_token, expires_in } = response.data;

    cachedToken = access_token;
    tokenExpiresAt = now + expires_in; // expires_in 是秒数

    console.log("Fetched new token:", cachedToken);
    return cachedToken;
  } catch (error: any) {
    console.error("Token fetch failed:", error.response?.data || error);
    return null;
  }
}

export async function getUserToken(config: TransportConfig): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);

  if (cachedUserToken && tokenExpiresAt > now + 60) {
    return cachedUserToken;
  }
  const { code_verifier, code_challenge } = generatePKCE();

  // 构造授权 URL
  const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  const clientId = "4b03b804-7fc8-43e2-a31d-263d422949e9";
  const scope = `${clientId}/.default`;
  const redirectUri = "http://localhost:44330/oauthcallback";

  const authorizeUrl =
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize` +
    `?client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&code_challenge=${code_challenge}` +
    `&code_challenge_method=S256`;

  // 打开登录页（只在本地环境）
  console.log("🔐 Opening browser for user login...");
  open(authorizeUrl);

  return new Promise((resolve) => {
    tokenWaiters.push(async (code: string) => {
      const token = await exchangeCodeForToken(code, code_verifier);
      if (token) {
        cachedUserToken = token;
        tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600;
        resolve(token);
      } else {
        resolve(null);
      }
    });
  });
}

export async function getToken(config: TransportConfig): Promise<string | null> {
  if (config.type == 'stdio' || config.runInAzure) {
    return getSecreteToken(config);
  } else {
    return getUserToken(config);
  }
}