import { SearchResults, Tool } from '../types';
import dotenv from 'dotenv';
import Exa from 'exa-js';

dotenv.config();
const apiKey = process.env.EXA_API_KEY;
if (!apiKey) {
  throw new Error('EXA_API_KEY is not set in the environment variables');
}
const exa = new Exa(apiKey);

// Exa.ai search tool
export const searchTool: Tool = {
  name: 'search',
  description: 'Search the web to get latest information on any topic',
  execute: async (query: string): Promise<SearchResults> => {
    const exaResults = await exa.searchAndContents(query, {
      type: 'neural',
      useAutoprompt: true,
      numResults: 5,
      text: true,
      highlights: true,
      summary: true,
    });

    return {
      results: exaResults.results.map((result: any) => ({
        title: result.title,
        url: result.url,
        content: result.text,
      })),
      query,
      numberOfResults: exaResults.results.length,
    };
  },
};
