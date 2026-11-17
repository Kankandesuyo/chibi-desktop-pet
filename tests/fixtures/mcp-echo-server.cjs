// Tiny MCP server over stdio for tests: tools "echo" and "add".
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo-server', version: '1.0.0' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, additionalProperties: false } },
  ] } });
  else if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params;
    if (name === 'echo') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${a.text}` }] } });
    else if (name === 'add') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }], structuredContent: { sum: a.a + a.b } } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'unknown tool' }] } });
  }
});
