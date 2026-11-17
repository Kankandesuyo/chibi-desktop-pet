'use strict';
// Shared fixed catalog: no user-provided paths, HTML or remote asset URLs.
(function (root) {
  const catalog = {
    orange: { label: '橙发女孩', image: '/pet.png', welcomeImage: '/happy.png', symbol: '✿', color: '#f07a2a', note: '暖橙色 · 原版形象' },
    deepseek: { label: 'DeepSeek 鲸鱼妹', image: '/deepseek.png', welcomeImage: '/deepseek.png', symbol: '🐋', color: '#506bd8', note: '蓝紫色 · 鲸鱼女仆立绘' },
  };
  const characterId = value => Object.hasOwn(catalog, value) ? value : 'orange';
  const api = { catalog, characterId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetCharacters = api;
})(globalThis);
