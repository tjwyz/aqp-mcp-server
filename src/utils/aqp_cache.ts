// utils/aqp_cache.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../aqp-data');
const memoryCache = new Map<string, any>();

export function setAqpCache(sessionId: string, data: any) {
  // 内存缓存
  memoryCache.set(sessionId, data);

  // 写入文件持久化
  const filePath = path.join(dataDir, `aqp-result-${sessionId}.json`);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function getAqpCache(sessionId: string): any | null {
  // 先查内存
  if (memoryCache.has(sessionId)) return memoryCache.get(sessionId);

  // 查文件
  const filePath = path.join(dataDir, `aqp-result-${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // 同时塞回内存加速下次访问
      memoryCache.set(sessionId, parsed);
      return parsed;
    } catch (e) {
      console.warn('[AQP CACHE] Failed to parse cache file:', e);
    }
  }

  return null;
}
