'use strict';

/**
 * 规则匹配引擎
 * 支持三种匹配类型：
 *   exact  - 精确匹配，如 "test.aisee.woa.com"
 *   suffix - 后缀通配，如 "*.aisee.woa.com" 匹配所有子域名
 *   regex  - 正则匹配，如 ".*\\.woa\\.com$"
 */

function matchRule(hostname, rule) {
  const { match, matchType } = rule;

  switch (matchType) {
    case 'exact':
      return hostname === match;

    case 'suffix': {
      const suffix = match.startsWith('*.') ? match.slice(2) : match;
      return hostname === suffix || hostname.endsWith('.' + suffix);
    }

    case 'regex':
      return new RegExp(match).test(hostname);

    default:
      return false;
  }
}

/**
 * 根据 hostname 查找匹配的规则
 * @param {string} hostname
 * @param {Array} rules
 * @returns {{ upstream: object } | null} 匹配到的规则，或 null 表示无匹配
 */
function findRule(hostname, rules) {
  for (const rule of rules) {
    if (matchRule(hostname, rule)) {
      return rule;
    }
  }
  return null;
}

module.exports = { findRule };
