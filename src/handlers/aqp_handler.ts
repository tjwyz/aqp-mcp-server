import fs from 'fs';
import { promises as fsPromise } from 'fs';
import path from 'path';
import axios from 'axios';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { AQPpost } from '../utils/aqp.js';
import { getToken } from '../utils/token.js';
import { setAqpCache, getAqpCache } from '../utils/aqp_cache.js';
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
      const paramString = JSON.stringify(paramList);

      const text = `
        You can extract relevant parameters from the user's natural language input and invoke the aqp_search tool when needed.
        The following are the currently supported ad query parameters:
      `
        .trim()
        .replace(/\s+/g, ' ');

      return {
        content: [
          {
            type: 'text',
            text: `${text}\n\n${JSON.stringify(paramString)}`,
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

  async aqpSearch(args: AqpSearchArgs, config: TransportConfig, sessionId: string) {
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
      const depclickTab = item.subTabs.find((t: any) => t.key === 'depclick');
      function toLowerCaseKeys(obj: Record<string, any>): Record<string, any> {
        const newObj: Record<string, any> = {};
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            newObj[key.toLowerCase()] = obj[key];
          }
        }
        return newObj;
      }
      const pClickScore = depclickTab?.components
        .find((c: any) => c.key === 'pclickscore')
        ?.contentData.map(toLowerCaseKeys);
      let ret = {
        adid: item.adCopy.adId,
        advertiserid: item.adCopy.advertiserId,
        campaignid: item.adCopy.campaignId,
        description: item.adCopy.description,
        listingid: item.adCopy.listingId,
        title: item.adCopy.title,
        uniquelistingadid: item.adCopy.uniqueListingAdId,
        urlid: item.adCopy.urlId,
        bid: overview?.Bid,
        bidstrategy: overview?.BidStrategy,
        biddedkeyword: overview?.BiddedKeyword,
        finaladjustedbid: overview?.FinalAdjustedBid,
        matchtype: overview?.MatchType,
        cpc: adservice?.Cpc,
        destinationurl: adservice?.DestinationUrl,
        rankscore: adservice?.RankScore,
        relevancescore: adservice?.RelevanceScore,
        pclick: adservice?.pClick,
        pclickscore: pClickScore,
      };

      if (adsplus) {
        ret = {
          ...ret,
          cpc: adsplus.Cpc, // 注意：仍然保留 destinationurl 用 adservice 的
        };
      }

      return ret;
    };

    const adsplus = extractSection('argads').map(filter);
    const adservice = extractSection('adserviceresult').map(filter);

    let fileToWrite = {
      adsplus,
      adservice,
    };
    // save
    setAqpCache(sessionId, fileToWrite);

    const prompt = `
      You will receive metadata of an ad search result.

      🔢 Stats:
      - total: Total number of ads
      - adservicelen: Ads filtered by AdService (not shown in ARG)
      - adspluslen: Final ads shown by ARG
      - schema: Example fields from one ad
      - downloadurl: Link to full data

      📌 Notes:
      - This is just metadata. You don’t have the full ad list yet.
      - Don’t analyze individual ads at this stage.
      - If the user asks for specific fields (e.g. adid, cpc, pclickscore), call the tool "filter_and_project_ads" with an expression like: "(ad) => ({ adid: ad.adid, cpc: ad.cpc })"

      Wait for the actual field extraction before summarizing or visualizing.
    `
      .trim()
      .replace(/\s+/g, ' ');

    let schema = JSON.parse(JSON.stringify(adservice[0]));
    schema.pclickscore = schema.pclickscore?.slice(0, 3) || [];
    const structuredContent = {
      total: adsplus.length + adservice.length,
      adservicelen: adservice.length,
      adspluslen: adsplus.length,
      schema,
      downloadurl: `http://localhost:3000/json?id=${sessionId}`,
    };

    const inputForLLM = `${prompt}\n\nJSON:\n${JSON.stringify(structuredContent)}`;

    if (!adsplus.length && !adservice.length) {
      return {
        content: [
          {
            type: 'text',
            text: 'No ad data was returned from the server. Please try again with different query or model.',
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: inputForLLM,
        },
      ],
    };
  }

  async filterAndProjectAds(
    args: { expression: string },
    config: TransportConfig,
    sessionId: string,
  ) {
    const { expression } = args;

    const data = getAqpCache(sessionId);
    if (!data) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ No cached ad data found for session "${sessionId}". Please call "aqp_search" first.`,
          },
        ],
      };
    }

    let transformFn: (ad: any) => any;
    try {
      const context = vm.createContext({});
      transformFn = vm.runInContext(`(${expression})`, context);
    } catch (e: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Invalid expression: ${e.message}`,
          },
        ],
      };
    }

    const results: any = { adservice: [], adsplus: [] };

    for (const [index, ad] of data.adservice.entries()) {
      try {
        results.adservice.push(transformFn(ad));
      } catch (e: any) {
        results.adservice.push({
          id: ad.adid ?? `index_${index}`,
          error: `❌ Failed to process ad: ${e.message}`,
        });
      }
    }

    for (const [index, ad] of data.adsplus.entries()) {
      try {
        results.adsplus.push(transformFn(ad));
      } catch (e: any) {
        results.adsplus.push({
          id: ad.adid ?? `index_${index}`,
          error: `❌ Failed to process ad: ${e.message}`,
        });
      }
    }

    const summary = `✅ Successfully transformed ${results.adservice.length} AdService ads and ${results.adsplus.length} AdsPlus ads.`;

    const inputForLLM = `${summary}\n\nJSON:\n${JSON.stringify(results)}`;

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
        You will receive a decoded JSON result from a Bing RLink. The structure is as follows:

        - originalUrl: The original Bing ad redirect URL.
        - destinationUrl: The decoded RLink destination URL (not escaped).
        - campaignId / adId / listingId: IDs related to the ad campaign.
        - cpc: Cost per click (high precision).
        - advertiserId: The advertiser’s ID.
        - domainType: Type of the landing page (e.g., 1 means redirect-type page).
        - searchQuery: The user's search query.
        - decodedParams: Full set of decoded parameters.

        ---

        📌 **Your Task:**

        1️⃣ Determine whether the landing page is a legitimate e-commerce page or a misleading/inducing one;  
        2️⃣ Analyze the relevance between the searchQuery and the landing page content;  
        3️⃣ Briefly describe the ad’s industry category (e.g., e-commerce, downloads, traffic redirection, etc.).
      `
        .trim()
        .replace(/\s+/g, ' ');

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
