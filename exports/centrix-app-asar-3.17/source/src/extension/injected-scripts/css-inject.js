/**
 * CSS注入内容脚本 (集成自 CSS inject 扩展)
 * 
 * 此脚本作为content_script在每个页面自动运行
 * 从chrome.storage.local中读取匹配当前域名的CSS并注入到页面
 */

function injectCSS() {
  const currentDomain = window.location.hostname;
  
  chrome.storage.local.get(['scripts', '_disabledScripts'], function(data) {
    const scripts = data.scripts || {};
    
    // 遍历所有脚本，查找匹配当前域名的CSS
    for (const key in scripts) {
      const script = scripts[key];
      const scriptDomain = script.domain;
      
      // 检查是否被禁用
      if (script.enabled === false) continue;
      
      // 域名匹配检查
      let matched = false;
      if (scriptDomain === currentDomain) {
        matched = true;
      } else if (scriptDomain && scriptDomain.startsWith('*.') && 
                 currentDomain.endsWith(scriptDomain.substring(1))) {
        matched = true;
      }
      
      if (matched && script.css && script.css.trim()) {
        // 移除已有的CSS注入
        removeExistingCSS();
        
        // 创建style标签注入CSS
        const styleElement = document.createElement('style');
        styleElement.setAttribute('id', 'centrix-css-inject');
        styleElement.setAttribute('data-source', 'centrix-extension');
        styleElement.textContent = script.css;
        document.head.appendChild(styleElement);
        
        console.log('[CentriX] CSS注入成功:', script.name || '未命名', '(' + scriptDomain + ')');
        break; // 只注入第一个匹配的CSS
      }
    }
  });
}

function removeExistingCSS() {
  const element = document.getElementById('centrix-css-inject');
  if (element) {
    element.parentNode.removeChild(element);
  }
}

// 监听来自popup/background的消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.type === 'updateCSS') {
    removeExistingCSS();
    if (request.css && request.css.trim()) {
      const styleElement = document.createElement('style');
      styleElement.setAttribute('id', 'centrix-css-inject');
      styleElement.setAttribute('data-source', 'centrix-extension');
      styleElement.textContent = request.css;
      document.head.appendChild(styleElement);
    }
    sendResponse({ success: true });
  } else if (request.type === 'removeCSS') {
    removeExistingCSS();
    sendResponse({ success: true });
  } else if (request.type === 'reloadCSS') {
    removeExistingCSS();
    injectCSS();
    sendResponse({ success: true });
  }
  return true;
});

// 页面加载时自动执行CSS注入
removeExistingCSS();
injectCSS();
