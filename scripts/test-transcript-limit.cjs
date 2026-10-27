// Exercise the actual example refresh function without a Shiny/DOM process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
  '../r-package/examples/06_in_situ_zoom_overlay_transcripts_interactive.R'), 'utf8');
const begin = source.indexOf('    async function refreshTranscriptsForROI()');
const end = source.indexOf('\n    function drawOverlay()', begin);
assert(begin >= 0 && end > begin);
async function test(count) {
  let writes = 0;
  const messages = [];
  const panel = {refreshData: async () => []};
  const inst = {queryServer: async () => ({rows: Array.from({length:count},()=>({x:1,y:1}))}),
    setRowsData: (_, rows) => { writes++; return {rows}; }};
  const context = {refreshSeq:0, MAX_TRANSCRIPTS:2, window:{__mosaic_glInstances:{test:inst}},
    x:{widgetId:'test'}, zoomSlot:{}, detailSlot:{}, findPanel:()=>panel,
    setStatus:(message)=>messages.push(message), transcriptSqlForROI:()=>'', ROI:{},
    detailRoiForROI:()=>({}), setPanelROI:()=>{}, drawOverlay:()=>{}, DETAIL:{px:1},
    countRowsInROI:rows=>rows.length, console:{warn:()=>{}}};
  await vm.runInNewContext('('+source.slice(begin,end).trim()+')',context)();
  assert.equal(writes,count>2?0:1,'overflow must not replace displayed rows');
  assert.match(messages.at(-1),count>2?/limit|too many|exceed/i:/Updated/);
}
(async()=>{
  await test(2); await test(3);
  assert.match(source,/as\.integer\(max_transcripts\)\s*\+\s*1L/,
    'query must fetch an extra row to detect overflow');
  console.log('PASS transcript refresh: bounded rows and overflow rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});
