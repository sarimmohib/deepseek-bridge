#!/usr/bin/env node
/*
 * Tiny OpenAI-compatible client used to smoke-test the bridge.
 *
 *   node bin/ds-chat.js "explain quicksort" --model deepseek-reasoner
 *   node bin/ds-chat.js --repl
 */
import { loadConfig } from '../src/config.js';
import readline from 'node:readline';

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0) {
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  return fallback;
};

const config = loadConfig();
const base = take('--url', `http://${config.host}:${config.port}`).replace(/\/$/, '');
const model = take('--model', 'deepseek-chat');
const repl = args.includes('--repl');
const prompt = args.filter((a) => !a.startsWith('--')).join(' ').trim();

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

async function stream(messages) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let stats = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.error) throw new Error(evt.error.message || 'stream error');
        if (evt.usage) stats = evt.usage;
        const delta = evt.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          process.stdout.write(dim(delta.reasoning_content));
        }
        if (delta.content) {
          if (reasoning && !content) process.stdout.write('\n\n');
          content += delta.content;
          process.stdout.write(delta.content);
        }
        const tc = delta.tool_calls;
        if (tc) process.stdout.write(`\n${bold('[tool_calls]')} ${JSON.stringify(tc)}\n`);
      }
    }
  }
  process.stdout.write('\n');
  if (stats) process.stdout.write(dim(`\n${stats.prompt_tokens} prompt + ${stats.completion_tokens} completion = ${stats.total_tokens} tokens\n`));
  return content;
}

if (repl) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: bold('you › ') });
  const history = [];
  console.log(dim(`model ${model} @ ${base} — ctrl-d to exit`));
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    history.push({ role: 'user', content: text });
    process.stdout.write(bold('ai › '));
    try {
      const reply = await stream(history);
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      console.error(`\n\x1b[31m${err.message}\x1b[0m`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
} else {
  if (!prompt) {
    console.error('usage: ds-chat "your prompt" [--model deepseek-reasoner] [--repl]');
    process.exit(1);
  }
  try {
    await stream([{ role: 'user', content: prompt }]);
  } catch (err) {
    console.error(`\x1b[31m${err.message}\x1b[0m`);
    process.exit(1);
  }
}
