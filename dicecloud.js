// Acesso à API do DiceCloud v2, leitura da ficha e rolagens (sem dependências, testável em Node).
// Formato conferido no código-fonte do DiceCloud (github.com/ThaumRystra/DiceCloud).

export const API_BASE = "https://dicecloud.com/api";
export const CHANNEL = "dicecloud-roller/roll";
export const LOG_KEY = "dicecloud-roller/log-v3";
export const TOAST_ID = "dicecloud-roller/toast";

const ABILITY_ORDER = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];

/** Aceita a URL da ficha (https://dicecloud.com/character/<id>/nome) ou só o id. */
export function extractCreatureId(input) {
  const text = String(input || "").trim();
  const match = text.match(/character\/([A-Za-z0-9]+)/);
  if (match) return match[1];
  return /^[A-Za-z0-9]+$/.test(text) ? text : null;
}

function buildUrl(path, proxy) {
  const url = `${API_BASE}${path}`;
  return proxy ? `${proxy}${url}` : url;
}

/** Login opcional (para fichas privadas). Retorna o token; a senha não é guardada. */
export async function login(username, password, proxy = "") {
  const body = username.includes("@") ? { email: username, password } : { username, password };
  let res;
  try {
    res = await fetch(buildUrl("/login", proxy), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Não consegui falar com o DiceCloud.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.reason || data.error || "Login recusado pelo DiceCloud.");
  return data.token;
}

/** Busca a ficha e devolve o texto JSON bruto (útil para detectar mudanças). */
export async function fetchCreatureText(id, { token = "", proxy = "" } = {}) {
  let res;
  try {
    res = await fetch(buildUrl(`/creature/${id}`, proxy), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new Error("Não consegui falar com o DiceCloud. Confira sua conexão.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Sem permissão para ler essa ficha. Deixe-a pública (Compartilhar → qualquer pessoa com o link) ou faça login.");
  }
  if (res.status === 404 || res.status === 400) throw new Error("Ficha não encontrada. Confira o link.");
  if (res.status === 429) throw new Error("Muitas requisições ao DiceCloud. Espere alguns segundos.");
  if (!res.ok) throw new Error(`DiceCloud respondeu com erro ${res.status}.`);
  return res.text();
}

// ---------- Leitura da ficha ----------

const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
/** Campo de texto com cálculos embutidos: usa o texto já calculado quando existir. */
const txt = (f) => (f && typeof f === "object" ? f.value ?? f.text ?? "" : typeof f === "string" ? f : "");
/** Campo calculado: valor final. */
const calc = (f) => (f && typeof f === "object" ? f.value : undefined);

/** p é descendente de a? (árvore por left/right; fichas antigas usam ancestors) */
function inside(p, a) {
  if (num(a.left, -1) >= 0 && num(p.left, -1) >= 0) return p.left > a.left && p.right < a.right;
  return p.parentId === a._id || (p.ancestors || []).some((x) => x.id === a._id);
}

/** Converte "1d8 + 3" em notação de dado rolável ("1d8+3"); null se não for só dados e números. */
export function toNotation(amount) {
  const s = String(amount ?? "").replace(/\s+/g, "").toLowerCase();
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(s) || !s.includes("d")) return null;
  return s.replace(/(^|[+-])d/g, "$11d");
}

export function parseCreature(data) {
  const all = (data.creatureProperties || [])
    .filter((p) => !p.removed)
    .sort((a, b) => num(a.left, num(a.order)) - num(b.left, num(b.order)));
  const active = all.filter((p) => !p.inactive);
  const current = active.filter((p) => !p.overridden);
  const ofType = (list, type) => list.filter((p) => p.type === type);

  // --- Atributos ---
  const attrs = ofType(current, "attribute").filter(
    (p) => !p.hide && !(p.hideWhenTotalZero && !num(p.total)) && !(p.hideWhenValueZero && !num(p.value))
  );
  const attrOf = (kind) => attrs.filter((p) => p.attributeType === kind);
  // Contadores (vida, espaços, recursos): o valor atual é total − damage.
  const pool = (p) => {
    const total = num(p.total);
    return {
      id: p._id,
      key: p.variableName || "",
      name: p.name || p.variableName,
      total,
      damage: num(p.damage, total - num(p.value, total)),
      reset: p.reset || "",
      // Vida temporária no DiceCloud: barra que pode passar do total (ignoreUpperLimit).
      ignoreUpper: !!p.ignoreUpperLimit,
      ignoreLower: !!p.ignoreLowerLimit,
    };
  };

  const abilities = attrOf("ability")
    .map((p) => {
      const score = num(p.total, num(p.value, 10));
      return { key: p.variableName, name: p.name || p.variableName, score, mod: num(p.modifier, Math.floor((score - 10) / 2)) };
    })
    .sort((a, b) => {
      const ia = ABILITY_ORDER.indexOf(a.key), ib = ABILITY_ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  // --- Perícias, resistências, testes, proficiências ---
  const skillProps = ofType(current, "skill").filter((p) => !p.hide);
  const skillsOf = (kind) =>
    skillProps
      .filter((p) => p.skillType === kind)
      .map((p) => ({
        key: p.variableName,
        name: p.name || p.variableName,
        ability: p.ability || "",
        mod: num(p.value),
        proficiency: num(p.proficiency),
        advantage: num(p.advantage),
      }));
  const saves = skillsOf("save").sort((a, b) => {
    const idx = (s) => ABILITY_ORDER.findIndex((k) => (s.key || "").toLowerCase().startsWith(k));
    return (idx(a) < 0 ? 99 : idx(a)) - (idx(b) < 0 ? 99 : idx(b));
  });
  const namesOf = (kind) => skillProps.filter((p) => p.skillType === kind && num(p.proficiency) > 0).map((p) => p.name || p.variableName);

  // --- Dano de ações e magias ---
  const damagesOf = (owner) =>
    all
      .filter((p) => p.type === "damage" && inside(p, owner) && !p.deactivatedByToggle)
      .map((p) => {
        const amount = calc(p.amount);
        return { amount: amount == null ? "" : String(amount), damageType: p.damageType || "", notation: toNotation(amount) };
      })
      .filter((d) => d.amount);

  const actionInfo = (p) => ({
    id: p._id,
    usesUsed: num(p.usesUsed),
    reset: p.reset || "",
    // Recursos gastos ao usar (ex.: pontos de ki): [{ key, quantity }]
    consumes: (p.resources?.attributesConsumed || [])
      .map((c) => ({ key: c.variableName || "", quantity: num(calc(c.quantity), 1) }))
      .filter((c) => c.key && c.quantity > 0),
    name: p.name || "Ação",
    actionType: p.actionType || "action",
    summary: txt(p.summary),
    description: txt(p.description),
    attackBonus: typeof calc(p.attackRoll) === "number" ? calc(p.attackRoll) : null,
    usesTotal: typeof calc(p.uses) === "number" && calc(p.uses) > 0 ? calc(p.uses) : 0,
    damages: damagesOf(p),
  });

  const actionProps = ofType(current, "action").filter((p) => p.actionType !== "event");
  const actions = actionProps.map(actionInfo);

  // --- Magias ---
  const listProps = ofType(all, "spellList");
  const spellLists = listProps
    .filter((p) => !p.inactive)
    .map((p) => ({ name: p.name || "Magias", dc: calc(p.dc) ?? null, attackBonus: calc(p.attackRollBonus) ?? null, maxPrepared: calc(p.maxPrepared) ?? null }));
  // Magias não preparadas ficam "inativas por si mesmas" na ficha; ainda assim entram na lista.
  const spells = ofType(all, "spell")
    .filter((p) => !p.deactivatedByAncestor && !p.deactivatedByToggle)
    .map((p) => {
      const list = listProps.find((l) => inside(p, l));
      const info = actionInfo(p);
      if (info.attackBonus == null && p.hasAttackRoll && typeof calc(list?.attackRollBonus) === "number") {
        info.attackBonus = calc(list.attackRollBonus);
      }
      const components = [p.verbal && "V", p.somatic && "S", p.material && `M (${p.material})`].filter(Boolean).join(", ");
      return {
        ...info,
        level: num(p.level),
        school: p.school || "",
        prepared: !!(p.prepared || p.alwaysPrepared),
        alwaysPrepared: !!p.alwaysPrepared,
        castingTime: p.castingTime || "",
        range: p.range || "",
        duration: p.duration || "",
        components,
        concentration: !!p.concentration,
        ritual: !!p.ritual,
        noSlot: !!p.castWithoutSpellSlots,
        list: list?.name || "",
        dc: typeof calc(list?.dc) === "number" ? calc(list.dc) : null,
      };
    })
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  // --- Inventário ---
  const containers = ofType(all, "container");
  const items = ofType(all, "item")
    .filter((p) => !p.deactivatedByToggle)
    .map((p) => {
      const quantity = num(p.quantity, 1);
      return {
        name: (quantity !== 1 && p.plural) || p.name || "Item",
        quantity,
        equipped: !!p.equipped,
        attuned: !!p.attuned,
        weight: num(p.weight),
        value: num(p.value),
        description: txt(p.description),
        container: containers.filter((c) => inside(p, c)).pop()?.name || "",
        // Ataques da arma. Inclui os de armas não equipadas (que o DiceCloud deixa inativos).
        actions: ofType(all, "action").filter((a) => a.actionType !== "event" && !a.overridden && inside(a, p)).map(actionInfo),
      };
    });

  // --- Classes e nível ---
  let classes = ofType(current, "class").map((p) => ({ name: p.name || p.variableName, level: num(p.level) }));
  if (!classes.length) {
    const byName = new Map();
    for (const p of ofType(active, "classLevel")) {
      const key = p.variableName || p.name;
      byName.set(key, { name: p.name || key, level: Math.max(num(p.level), byName.get(key)?.level || 0) });
    }
    classes = [...byName.values()];
  }

  const described = (type) =>
    ofType(active, type).map((p) => ({ name: p.name || "", summary: txt(p.summary), description: txt(p.description) }));

  const creature = data.creatures?.[0] || {};
  return {
    name: creature.name || "Personagem",
    avatar: creature.avatarPicture || creature.picture || "",
    alignment: creature.alignment || "",
    classes,
    level: classes.reduce((sum, c) => sum + c.level, 0),
    // Barras de vida aparecem sempre, mesmo zeradas (ex.: vida temporária).
    healthBars: ofType(current, "attribute").filter((p) => p.attributeType === "healthBar" && !p.hide).map(pool),
    stats: attrOf("stat").map((p) => ({ key: p.variableName || "", name: p.name || p.variableName, value: p.value ?? p.total ?? 0 })),
    modifiers: attrOf("modifier").map((p) => ({ key: p.variableName || "", name: p.name || p.variableName, value: num(p.value) })),
    hitDice: attrOf("hitDice").map((p) => ({ ...pool(p), size: p.hitDiceSize || "" })),
    resources: attrOf("resource").map(pool),
    spellSlots: attrOf("spellSlot").map((p) => ({ ...pool(p), level: num(calc(p.spellSlotLevel)) })).filter((s) => s.total > 0),
    abilities,
    saves,
    skills: skillsOf("skill").sort((a, b) => a.name.localeCompare(b.name)),
    checks: skillsOf("check"),
    proficiencies: {
      armor: namesOf("armor"),
      weapon: namesOf("weapon"),
      tool: namesOf("tool"),
      language: namesOf("language"),
    },
    actions,
    spellLists,
    spells,
    items,
    features: described("feature"),
    buffs: described("buff"),
    notes: described("note"),
  };
}

// ---------- Rolagens ----------

function die(sides) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / sides) * sides;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return (buf[0] % sides) + 1;
}

export const fmtMod = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

/** d20 + modificador. mode: "normal" | "adv" | "dis". Retorna { detail, total, nat }. */
export function rollD20(mod, mode = "normal") {
  const dice = mode === "normal" ? [die(20)] : [die(20), die(20)];
  const kept = mode === "adv" ? Math.max(...dice) : mode === "dis" ? Math.min(...dice) : dice[0];
  return d20Result(dice, kept, mod);
}

export function d20Result(dice, kept, mod) {
  const shown = dice.length > 1 ? `${dice.join(", ")} → ${kept}` : `${kept}`;
  return { detail: `[${shown}] ${fmtMod(mod)}`, total: kept + mod, nat: kept === 20 ? 20 : kept === 1 ? 1 : null };
}

/** Rola uma notação simples como "2d6+1d4+3". Retorna { detail, total } ou null se inválida. */
export function rollNotation(notation) {
  const terms = String(notation).match(/[+-]?(\d*d\d+|\d+)/g);
  if (!terms || terms.join("") !== notation) return null;
  let total = 0;
  const parts = [];
  for (const term of terms) {
    const sign = term.startsWith("-") ? -1 : 1;
    const body = term.replace(/^[+-]/, "");
    let text, value;
    if (body.includes("d")) {
      const [count, sides] = body.split("d").map((x) => parseInt(x || "1", 10));
      if (!sides || count > 100) return null;
      const rolls = Array.from({ length: count }, () => die(sides));
      value = rolls.reduce((a, b) => a + b, 0);
      text = `[${rolls.join(", ")}]`;
    } else {
      value = parseInt(body, 10);
      text = String(value);
    }
    total += sign * value;
    parts.push(parts.length ? `${sign < 0 ? "−" : "+"} ${text}` : `${sign < 0 ? "−" : ""}${text}`);
  }
  return { detail: parts.join(" "), total, nat: null };
}

/** Texto único de um evento (rolagem ou uso), para o histórico e a notificação simples. */
export function formatRoll(entry) {
  if (entry.kind === "use") return `${entry.character} ${entry.label}${entry.sub ? " (" + entry.sub + ")" : ""}`;
  const crit = entry.nat === 20 ? " — 20 natural!" : entry.nat === 1 ? " — 1 natural!" : "";
  return `${entry.character} · ${entry.label}: ${entry.detail} = ${entry.total}${crit}`;
}

/** Corta textos longos para caber no cartão de notificação. */
export function clip(text, max = 220) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
