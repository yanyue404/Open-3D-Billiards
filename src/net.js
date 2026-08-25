// ============================================================
// 联机客户端:与同源服务器 /ws 建立 WebSocket
// 只传出杆参数等小包,双端确定性模拟保证一致
// ============================================================
export function createNet(handlers) {
  let ws = null;
  let connected = false;

  function connect() {
    return new Promise((resolve, reject) => {
      if (connected) { resolve(); return; }
      if (location.protocol === 'file:') {
        reject(new Error('离线版不支持联机,请用 node server/server.js 启动后访问'));
        return;
      }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        ws = new WebSocket(`${proto}//${location.host}/ws`);
      } catch (e) { reject(new Error('无法创建连接')); return; }
      const timer = setTimeout(() => {
        if (!connected) { try { ws.close(); } catch { } reject(new Error('连接超时')); }
      }, 6000);
      ws.onopen = () => { connected = true; clearTimeout(timer); resolve(); };
      ws.onerror = () => {
        clearTimeout(timer);
        if (!connected) reject(new Error('连接失败(请通过 node server/server.js 启动的地址访问)'));
      };
      ws.onclose = () => {
        const was = connected;
        connected = false;
        if (was && handlers.onDisconnect) handlers.onDisconnect();
      };
      ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (handlers.onMessage) handlers.onMessage(m);
      };
    });
  }

  return {
    connect,
    isConnected: () => connected,
    send(obj) {
      if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    },
    close() {
      if (ws) { try { ws.close(); } catch { } }
      connected = false;
    },
  };
}
