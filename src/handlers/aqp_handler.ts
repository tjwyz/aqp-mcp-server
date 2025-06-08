import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { AQPpost } from '../utils/aqp.js';
import { getToken } from '../utils/token.js';
import { TransportConfig } from '../utils/transport_config.js';

type ParamItem = {
  parameter: string;
  value: string;
  isPostBody: boolean;
};

type AqpSearchArgs = {
  model: string;
  query: string;
  params?: ParamItem[];
};
type RLinkArgs = {
  rlink: string;
};

export class AQPHandler {
  constructor() {}

  async generateAqpSearchPrompt(args: { userInput: string }) {
    try {
      if (!args.userInput) {
        throw new McpError(ErrorCode.InvalidParams, 'userInput parameter is required.');
      }

      const paramList = (global as any).paramList;
      const paramString = JSON.stringify(paramList, null, 2);

      const text = `
        以下是当前支持的广告查询参数：

        ${paramString}

        你可以基于用户输入的自然语言内容，从中提取出相关参数，并在需要时调用 aqp_search 工具。
      `.trim();

      // logger.info("AQP generateAqpSearchPrompt Response:", true);

      return {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      };
    } catch (error: any) {
      const errorMessage =
        error instanceof McpError ? error.message : error?.message || String(error);

      logger.error('Error in generateAqpSearchPrompt:', { error: errorMessage });

      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  async aqpSearch(args: AqpSearchArgs, config: TransportConfig) {
    const { model, query, params = [] } = args;

    const queryStringList: string[] = [];
    const queryStringData: Record<string, string> = {};
    const postData: Record<string, string> = {};

    if (query) queryStringList.push('query=' + encodeURIComponent(query));
    if (model) queryStringList.push('mode=' + encodeURIComponent(model));

    const paramList: ParamItem[] = (global as any).paramList || [];

    const allParams = [...paramList, ...params];
    for (const item of allParams) {
      const { parameter, value, isPostBody } = item;
      if (!parameter) continue;

      if (isPostBody) {
        postData[parameter] = value;
      } else {
        queryStringData[parameter] = encodeURIComponent(value);
      }
    }

    for (const key in queryStringData) {
      queryStringList.push(`${key}=${queryStringData[key]}`);
    }

    const urlParams =
      `https://adqueryprobet.trafficmanager.net/api/v1/query/textad?` + queryStringList.join('&');

    const token = await getToken(config);
    const result = await AQPpost({ url: urlParams, body: postData, token });

    const binglive = result.data.resultSections.find((s: any) => s.key === 'binglive');

    const extractSection = (key: string) =>
      binglive?.sections.find((s: any) => s.key === key)?.resultAdList ?? [];

    const filter = (item: any) => {
      const overviewTab = item.subTabs.find((t: any) => t.key === 'overview');
      const overview = overviewTab?.components.find((c: any) => c.key === 'overview')
        ?.contentData?.[0];
      const adservice = overviewTab?.components.find((c: any) => c.key === 'adservice')
        ?.contentData?.[0];
      const adsplus = overviewTab?.components.find((c: any) => c.key === 'adsplus')
        ?.contentData?.[0];
      let ret = {
        adId: item.adCopy.adId,
        advertiserId: item.adCopy.advertiserId,
        campaignId: item.adCopy.campaignId,
        description: item.adCopy.description,
        listingId: item.adCopy.listingId,
        title: item.adCopy.title,
        uniqueListingAdId: item.adCopy.uniqueListingAdId,
        urlId: item.adCopy.urlId,
        Bid: overview.Bid,
        BidStrategy: overview.BidStrategy,
        BiddedKeyword: overview.BiddedKeyword,
        FinalAdjustedBid: overview.FinalAdjustedBid,
        MatchType: overview.MatchType,
        Cpc: adservice.Cpc,
        DestinationUrl: adservice.DestinationUrl,
        RankScore: adservice.RankScore,
        RelevanceScore: adservice.RelevanceScore,
        pClick: adservice.pClick,
      };
      if (adsplus) {
        ret = {
          ...ret,
          Cpc: adsplus.Cpc,
          DestinationUrl: adservice.DestinationUrl,
        };
      }
      return ret;
    };

    const adsplus = extractSection('argads').map(filter);
    const adservice = extractSection('adserviceresult').map(filter);

    // 保存文件的路径
    const timestamp = Date.now();
    const fileName = `aqp-result-${timestamp}.json`;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const dir = path.resolve(__dirname, '../../aqp-data/');
    const filePath = path.join(dir, fileName);

    const prompt = `
      你将收到一份广告分析数据，结构如下：
      1. total: 总广告数（ adservice + adsplus 的合计）。
      2. adserviceLen: adservice中广告的数量
      3. adsplusLen: adsplus中广告的数量
      4. adservice: 广告服务（AdService）阶段中筛选出的广告，这些广告虽然通过了初步筛选，但**最终未在 ARG 阶段展示**。
      5. adsplus: 最终在 ARG 阶段成功展示的广告列表，**是 adservice 的子集**，即从候选广告中“脱颖而出”的展示广告。
      6. downloadUrl: 完整 JSON 文件的下载链接，供深入查看数据结构使用。

      每条广告都包含关键字段，如：
      - 基本信息：title、description、advertiserId、campaignId
      - 关键词出价：Bid、 FinalAdjustedBid、 BidStrategy、MatchType、BiddedKeyword
      - 排名与点击预测：RankScore、RelevanceScore、pClick、Cpc

      ---

      📌 **你的任务：**

      1️⃣ 总览：总结本次广告分布与投放结果；
      2️⃣ 精选广告：从 adsplus 中挑选 3 条广告，展示其 title、Cpc、pClick、RankScore；

      注意：请勿复述全部 JSON 数据，重点突出结构清晰和核心指标。
    `.trim();

    const structuredContent = {
      total: adsplus.length + adservice.length,
      adserviceLen: adservice.length,
      adsplusLen: adsplus.length,
      adservice,
      adsplus,
      downloadUrl: `http://aqpmcp.eastus.cloudapp.azure.com:3000/json?id=${timestamp}`,
    };
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(structuredContent, null, 2), 'utf-8');

    const inputForLLM = `${prompt}\n\nJSON:\n${JSON.stringify(structuredContent)}`;

    return {
      content: [
        {
          type: 'text',
          text: inputForLLM,
        },
      ],
    };
  }

  async decodeRlink(args: { url: string }, config: TransportConfig) {
    try {
      const urlParams = `https://adqueryprobet.trafficmanager.net/api/v1/tools/UrlDecryption`;
      const token = await getToken(config);
      const postData = {
        type: 'RLink',
        url: args.url,
      };
      const result = await AQPpost({ url: urlParams, body: postData, token });

      const data = result?.data?.DecodedResult;
      if (!data || !data.DestinationUrlDecoded) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid decode result or missing DestinationUrlDecoded',
        );
      }

      const prompt = `
        你将收到一份 Bing RLink 解码结果，结构如下：

        - originalUrl: 原始 Bing 广告跳转链接；
        - destinationUrl: 原始 rlink 解码后的 URL（未转义）；
        - campaignId / adId / listingId: 广告投放相关 ID；
        - cpc: 点击成本（高精度）；
        - advertiserId: 广告主 ID；
        - domainType: 广告类型（例如 1 代表页面跳转类）；
        - searchQuery: 用户搜索的关键词；
        - decodedParams: 解析出的参数全集；

        ---

        📌 **你的任务：**

        1️⃣ 判断落地页是否为合理电商页或诱导页；
        2️⃣ 提取 search_query 与落地页之间的相关性；
        3️⃣ 简要描述广告所属行业（如电商、下载类、导流页等）；
      `.trim();

      const structuredContent = {
        originalUrl: args.url,
        destinationUrl: data.DestinationUrlDecoded,
        campaignId: data.CampaignId,
        adId: data.AdId,
        listingId: data.ListingId,
        advertiserId: data.AdvertiserId,
        cpc: data.CpcHighPrecision,
        domainType: data.DomainType,
        searchQuery: data._x_ns_query || null, // 若想抽出 query 可加
        decodedParams: data,
      };

      const inputForLLM = `${prompt}\n\nJSON:\n${JSON.stringify(structuredContent)}`;

      return {
        content: [
          {
            type: 'text',
            text: inputForLLM,
          },
        ],
      };
    } catch (err) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Failed to decode rlink: ' + (err as Error).message,
      );
    }
  }
}
