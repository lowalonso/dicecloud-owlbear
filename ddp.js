// Gravação na ficha do DiceCloud.
// A API REST do DiceCloud é somente leitura, então as alterações (vida, espaços, usos)
// vão pela mesma conexão em tempo real que o próprio site usa (DDP sobre WebSocket),
// chamando o método "creatureProperties.update". Exige login com permissão de edição.

const WS_URL = "wss://dicecloud.com/websocket";
const GAP_MS = 450; // o DiceCloud limita a 12 alterações a cada 5 s

export function createSync(getToken) {
  let ws = null;
  let ready = null;
  let nextId = 1;
  const waiting = new Map();
  let queue = Promise.resolve();

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(nextId++);
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ msg: "method", method, params, id }));
    });
  }

  function drop(reason) {
    ready = null;
    for (const w of waiting.values()) w.reject(new Error(reason));
    waiting.clear();
    try { ws?.close(); } catch { /* já fechado */ }
    ws = null;
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { drop("O DiceCloud não respondeu."); reject(new Error("O DiceCloud não respondeu.")); }, 10000);
      ws = new WebSocket(WS_URL);
      ws.onopen = () => ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
      ws.onmessage = (event) => {
        let m;
        try { m = JSON.parse(event.data); } catch { return; }
        if (m.msg === "ping") ws.send(JSON.stringify(m.id ? { msg: "pong", id: m.id } : { msg: "pong" }));
        else if (m.msg === "connected") {
          call("login", [{ resume: getToken() }]).then(
            () => { clearTimeout(timer); resolve(); },
            () => { clearTimeout(timer); drop("login"); reject(new Error("Sessão do DiceCloud expirada. Entre de novo nas opções.")); });
        } else if (m.msg === "failed") {
          clearTimeout(timer); drop("versão"); reject(new Error("O DiceCloud recusou a conexão."));
        } else if (m.msg === "result") {
          const w = waiting.get(m.id);
          if (!w) return;
          waiting.delete(m.id);
          if (m.error) w.reject(new Error(m.error.reason || m.error.message || "O DiceCloud recusou a alteração."));
          else w.resolve(m.result);
        }
      };
      ws.onclose = ws.onerror = () => {
        clearTimeout(timer);
        drop("Conexão com o DiceCloud caiu.");
        reject(new Error("Não consegui conectar ao DiceCloud para salvar."));
      };
    });
    ready.catch(() => { ready = null; });
    return ready;
  }

  return {
    /** Define um campo de uma propriedade da ficha, ex.: update(id, ["damage"], 5). */
    update(_id, path, value) {
      const job = queue
        .then(connect)
        .then(() => call("creatureProperties.update", [{ _id, path, value }]));
      queue = job.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP_MS)));
      return job;
    },
  };
}
