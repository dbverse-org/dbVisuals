const {chromium} = require('playwright');

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error('DEEPSEEK_API_KEY is required');
}

const aiSettings = {
  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: [
        {id: 'gpt-5.2', modelName: 'gpt-5.2'},
        {id: 'gpt-5', modelName: 'gpt-5'},
      ],
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '',
      models: [
        {id: 'claude-3-5-sonnet', modelName: 'claude-3-5-sonnet'},
        {id: 'claude-3-5-haiku', modelName: 'claude-3-5-haiku'},
      ],
    },
    google: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: '',
      models: [{id: 'gemini-2.0-flash', modelName: 'gemini-2.0-flash'}],
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey,
      models: [{id: 'deepseek-chat', modelName: 'deepseek-chat'}],
    },
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      models: [{id: 'qwen3:32b', modelName: 'qwen3:32b'}],
    },
  },
  customModels: [],
  modelParameters: {maxSteps: 50, additionalInstruction: ''},
};

async function main() {
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1400, height: 900}});

  await context.addInitScript((settings) => {
    localStorage.setItem(
      'ai-example-app-state-storage',
      JSON.stringify({state: {aiSettings: settings}, version: 3}),
    );
  }, aiSettings);

  const page = await context.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

  await page.goto('http://127.0.0.1:5174/', {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(10000);
  await page.locator('button').nth(2).click({timeout: 30000});
  await page.getByText('A1', {exact: true}).waitFor({timeout: 30000});

  await submitPrompt(
    page,
    'hello. Populate slot A1 with a linked histogram of total_expr from giotto_cells. Use create_bridge_visualization with title Expression histogram.',
  );
  await page.getByText('Expression histogram', {exact: true}).waitFor({
    timeout: 180000,
  });
  await waitForIdle(page);

  await submitPrompt(
    page,
    'nice now add a direct deck.gl GeoArrow pointMap to A2 from giotto_cells using x and y, colored by total_expr. Use create_bridge_visualization with the shared brush selection.',
  );
  await page.waitForFunction(
    () => {
      const state = JSON.parse(
        localStorage.getItem('ai-example-app-state-storage') || '{}',
      ).state;
      return Boolean(state?.canvas?.panels?.A2);
    },
    null,
    {timeout: 180000},
  );
  await waitForIdle(page);
  await page.getByText(/(Cell|Giotto).*Centroid|pointMap|GeoArrow/i).first().waitFor({
    timeout: 180000,
  });

  await submitPrompt(
    page,
    'add a direct deck.gl GeoArrow polygonMap to B1 from giotto_cell_polygons using geom, x, y, and total_expr. Use create_bridge_visualization with the shared brush selection.',
  );
  await page.waitForFunction(
    () => {
      const state = JSON.parse(
        localStorage.getItem('ai-example-app-state-storage') || '{}',
      ).state;
      return Boolean(state?.canvas?.panels?.B1);
    },
    null,
    {timeout: 180000},
  );
  await waitForIdle(page);
  await page.waitForTimeout(8000);

  const body = await page.locator('body').innerText({timeout: 5000});
  const storedCanvas = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('ai-example-app-state-storage') || '{}')
        .state?.canvas,
  );
  const hasA2 = Boolean(storedCanvas?.panels?.A2);
  const hasB1 = Boolean(storedCanvas?.panels?.B1);
  const hardErrors = logs.filter(
    (line) =>
      line.startsWith('pageerror:') ||
      line.includes('Type validation failed') ||
      line.includes('[VgPlotChart] Error') ||
      line.includes('[object Object]') ||
      line.includes('rectRaster'),
  );

  console.log(
    JSON.stringify({
      hasA1: body.includes('Expression histogram'),
      hasA2,
      hasB1,
      hasTypeValidationError: body.includes('Type validation failed'),
      hardErrors,
      canvas: storedCanvas,
    }),
  );

  await page.screenshot({path: 'deepseek-canvas-a1.png', fullPage: true});
  await browser.close();

  if (
    !body.includes('Expression histogram') ||
    !hasA2 ||
    !hasB1 ||
    body.includes('Type validation failed') ||
    hardErrors.length > 0
  ) {
    process.exit(1);
  }
}

async function submitPrompt(page, prompt) {
  const composer = page.locator('textarea[placeholder^="Update panels"]');
  await composer.fill(prompt);
  await composer.press('Enter');
}

async function waitForIdle(page) {
  await page.waitForFunction(
    () => {
      const state = JSON.parse(
        localStorage.getItem('ai-example-app-state-storage') || '{}',
      ).state;
      const currentSessionId = state?.ai?.currentSessionId;
      const currentSession = state?.ai?.sessions?.find(
        (session) => session.id === currentSessionId,
      );
      return currentSession?.isRunning === false;
    },
    null,
    {timeout: 180000},
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
