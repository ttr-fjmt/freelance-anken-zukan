'use strict';

/**
 * Minimal robots.txt fetcher/checker. Caches one ruleset per origin so a
 * multi-page crawl only fetches robots.txt once per host.
 */

const cache = new Map();

function parseRobots(text) {
  const lines = text.split(/\r?\n/);
  const groups = []; // { agents: string[], disallow: string[], allow: string[] }
  let current = null;

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || current.started) {
        current = { agents: [], disallow: [], allow: [], started: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow') {
      if (current) { current.started = true; if (value) current.disallow.push(value); }
    } else if (key === 'allow') {
      if (current) { current.started = true; if (value) current.allow.push(value); }
    }
  }

  // Prefer a group that explicitly names our bot, else fall back to '*'.
  return groups;
}

function rulesForAgent(groups, userAgentToken) {
  const token = userAgentToken.toLowerCase();
  const named = groups.find(g => g.agents.includes(token));
  const wildcard = groups.find(g => g.agents.includes('*'));
  const group = named || wildcard;
  if (!group) return { disallow: [], allow: [] };
  return { disallow: group.disallow, allow: group.allow };
}

async function loadRulesForOrigin(origin, userAgent, fetchImpl = fetch) {
  if (cache.has(origin)) return cache.get(origin);

  let rules = { disallow: [], allow: [] };
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { 'User-Agent': userAgent },
    });
    if (res.ok) {
      const text = await res.text();
      const groups = parseRobots(text);
      rules = rulesForAgent(groups, userAgent.split('/')[0]);
    }
    // Non-200 (404 etc.) => no robots.txt published => treat as allow-all.
  } catch (err) {
    console.warn(`robots.txt fetch failed for ${origin}: ${err.message}. Assuming allow-all.`);
  }

  cache.set(origin, rules);
  return rules;
}

function isPathAllowed(rules, pathname) {
  const disallowMatch = rules.disallow
    .filter(rule => rule && pathname.startsWith(rule))
    .sort((a, b) => b.length - a.length)[0];
  if (!disallowMatch) return true;

  const allowMatch = rules.allow
    .filter(rule => rule && pathname.startsWith(rule))
    .sort((a, b) => b.length - a.length)[0];
  if (allowMatch && allowMatch.length >= disallowMatch.length) return true;

  return false;
}

async function isUrlAllowed(url, userAgent, fetchImpl = fetch) {
  const u = new URL(url);
  const rules = await loadRulesForOrigin(u.origin, userAgent, fetchImpl);
  return isPathAllowed(rules, u.pathname);
}

module.exports = { loadRulesForOrigin, isPathAllowed, isUrlAllowed, parseRobots };
