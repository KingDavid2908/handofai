import { WebProvider } from './src/tool/web-provider';

async function test() {
  console.log('Testing Tavily...');
  const t = await WebProvider.testConnection('tavily', 'tvly-test');
  console.log('Tavily result:', t);

  console.log('Testing Firecrawl...');
  const f = await WebProvider.testConnection('firecrawl', 'fc-test');
  console.log('Firecrawl result:', f);

  console.log('Testing TinyFish...');
  const tf = await WebProvider.testConnection('tinyfish', 'tf-test');
  console.log('TinyFish result:', tf);
}

test();
