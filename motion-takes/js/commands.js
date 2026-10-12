// ------------------------------------------------
// Commands: what you can say or type.
//
// interpret(text, api) turns a phrase into an action and
// a plain-language reply. Known phrases are matched here,
// the same way every time. A phrase this file doesn't know
// can go to Claude (when the page is hosted where Claude is
// available); Claude may only retime pieces, and its edits
// are shown and undoable like any other.
// ------------------------------------------------

import {
  FEELINGS, FEELING_WORDS, SCALE_MIN, applyFeeling, describe, editOf, feelingReasons, feelingScore,
  interiorHolds, metrics, pieceLabel, pieceName, piecesOf, resetEdits, setEdit, timingOf,
} from './edit.js';
import { effectiveSmoothing, effectiveSpeed } from './takes.js';

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, first: 1, second: 2, third: 3, fourth: 4 };
const ORD = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 };

const has = (s, re) => re.test(s);
const secs = ms => `${(ms / 1000).toFixed(2)} s`;

export const HELP = [
  ['Perform', '“record”, “stop”, “replay”, “pause”, “go live”'],
  ['Compare', '“compare 1 and 2”, “compare all”, “solo”, “take 3”, “next take”'],
  ['Read', '“describe”, “what’s different?”, “which feels more confident?”'],
  ['Edit pieces', '“longer pause”, “cut the second pause”, “snappier entrance”, “ease out the end”'],
  ['Edit by feeling', '“make it calmer”, “more nervous”, “make a confident version”'],
  ['Whole take', '“half speed”, “smoother”, “reset”, “call it shy hello”, “undo”'],
];

function feelingIn(s) {
  for (const [key, words] of Object.entries(FEELING_WORDS)) {
    for (const w of words) if (new RegExp(`\\b${w}\\b`).test(s)) return key;
  }
  return null;
}

function takeNumbers(s) {
  const out = [];
  const re = /\b(?:take\s*)?(\d|one|two|three|four|five|six|seven|eight|nine)\b/g;
  let m;
  while ((m = re.exec(s))) out.push(NUM[m[1]] || +m[1]);
  return out;
}

function takeRef(s, api) {
  const takes = api.takes();
  const m = s.match(/\btake\s*(\d|one|two|three|four|five|six|seven|eight|nine)\b/);
  if (m) return takes[(NUM[m[1]] || +m[1]) - 1] || null;
  if (has(s, /\b(last|latest|newest) (one|take)\b/)) return takes[takes.length - 1];
  if (has(s, /\bfirst (one|take)\b/)) return takes[0];
  return api.selected();
}

// Which piece a phrase points at, or null.
function pieceRef(s, take, api) {
  const timing = timingOf(take);
  const inner = interiorHolds(timing);
  const holds = inner.length ? inner : timing.filter(p => p.kind === 'hold');
  const moves = timing.filter(p => p.kind === 'move');
  const bigMoves = moves.filter(p => p.dist >= 0.06);
  const sel = api.selectedPiece();
  const pauseWord = /\b(pause|pauses|hold|holds|hesitation|hesitations|stop|wait|beat|gap|stillness)\b/;

  const m = s.match(/\bpiece\s*(\d+)\b/);
  if (m) return timing[+m[1] - 1] ? [timing[+m[1] - 1]] : [];

  const ord = s.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(pause|hold|hesitation|stop|wait|move)\b/);
  if (ord) {
    const list = ord[2] === 'move' ? bigMoves : holds;
    const p = ord[1] === 'last' ? list[list.length - 1] : list[ORD[ord[1]]];
    return p ? [p] : [];
  }
  if (has(s, pauseWord)) {
    if (has(s, /\b(pauses|holds|all the|every)\b/)) return holds;
    if (sel != null && timing[sel] && timing[sel].kind === 'hold') return [timing[sel]];
    const longest = holds.slice().sort((a, b) => (b.d1 - b.d0) - (a.d1 - a.d0))[0];
    return longest ? [longest] : [];
  }
  if (has(s, /\b(entrance|entry|start|beginning|opening|intro|first move|arrival|comes in)\b/)) return bigMoves[0] ? [bigMoves[0]] : moves.slice(0, 1);
  if (has(s, /\b(end|ending|exit|landing|finish|final move|last move|settle|resolution)\b/)) return bigMoves.length ? [bigMoves[bigMoves.length - 1]] : moves.slice(-1);
  if (has(s, /\b(drift|drifts|doubt|wobble)\b/)) return moves.filter(p => p.dist < 0.06);
  if (has(s, /\b(moves|movements)\b/)) return moves;
  if (has(s, /\b(this|here|it|that)\b/) && sel != null && timing[sel]) return [timing[sel]];
  return null;
}

function amount(s, up) {
  if (has(s, /\b(much|lot|way|really|twice|double)\b/)) return up ? 2 : 0.4;
  if (has(s, /\b(bit|little|slightly|touch|tad)\b/)) return up ? 1.2 : 0.82;
  return up ? 1.5 : 0.65;
}

function snapshotLabels(take, pieces) {
  return pieces.map(p => ({ i: p.i, before: pieceLabel(take, p.i), dur: p.d1 - p.d0 }));
}
function changeReport(take, before) {
  const after = timingOf(take);
  return before.map(b => {
    const a = after[b.i];
    return `${pieceName(take, b.i)}: ${secs(b.dur)} → ${secs(a.d1 - a.d0)}`;
  }).join(' · ');
}

export async function interpret(raw, api) {
  const text = raw.trim();
  const s = ' ' + text.toLowerCase().replace(/[“”"’]/g, "'").replace(/[^\w\s.'×-]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const words = s.trim().split(' ').filter(Boolean);
  // a phrase that names a piece is an edit, never a transport command ("cut the second pause")
  const short = words.length <= 4 && !/\b(pause|hold|hesitat\w*|entrance|move|piece|end|ending|start|drift|version)\b/.test(s);
  const take = api.selected();

  if (!text) return null;

  // --- help / history
  if (has(s, /\b(help|what can i (say|do)|commands)\b/)) return { kind: 'help', reply: 'Here’s what I understand:', help: true };
  if (has(s, /^\s*(undo|go back|take that back|never mind|nevermind)\b/)) return { kind: 'info', reply: api.undo() ? 'Undone.' : 'Nothing to undo.' };
  if (has(s, /^\s*(redo)\b/)) return { kind: 'info', reply: api.redo() ? 'Redone.' : 'Nothing to redo.' };

  // --- transport (short phrases only, so “longer pause” isn't a command to pause)
  if (short && has(s, /\b(record|recording|action|roll|lets go|let's go|from the top|another take|new take)\b/) && !has(s, /\bversion\b/)) {
    api.record();
    return { kind: 'action', reply: api.input() === 'hand' && api.grabGate() ? 'Ready. Pinch to start; let go to stop.' : 'Recording after the count-in.' };
  }
  if (short && has(s, /\b(stop|cut|done|finish|that's it|end it)\b/)) { api.stop(); return { kind: 'action', reply: 'Stopped.' }; }
  if (short && has(s, /\b(replay|play|again|play it|play back|playback|watch|show me)\b/) && !takeNumbers(s).length) { api.play(); return { kind: 'action', reply: take ? `Playing ${take.name}.` : 'Record a take first.' }; }
  if (short && has(s, /^\s*(pause|freeze|hold on|wait)\s*$/)) { api.pause(); return { kind: 'action', reply: 'Paused.' }; }
  if (short && has(s, /\b(live|rehearse|practice|practise)\b/)) { api.live(); return { kind: 'action', reply: 'Live. Nothing is kept until you record.' }; }
  if (has(s, /\bloop (off|no)\b|\bstop looping\b/)) { api.setLoop(false); return { kind: 'action', reply: 'Loop off.' }; }
  if (has(s, /\bloop( on| it)?\b/) && short) { api.setLoop(true); return { kind: 'action', reply: 'Looping.' }; }

  if (!api.takes().length) return { kind: 'info', reply: 'There are no takes yet. Say “record” or press R.' };

  // --- comparing and choosing
  if (has(s, /\bcompare (all|everything|them all|every take)\b|\bshow (all|everything)\b/)) {
    api.compare(api.takes().filter(t => t !== take));
    return { kind: 'action', reply: `Comparing all ${api.takes().length} takes.` };
  }
  if (has(s, /\bcompare\b|\bside by side\b|\bagainst\b/)) {
    const nums = takeNumbers(s).map(n => api.takes()[n - 1]).filter(Boolean);
    if (nums.length >= 2) { api.select(nums[0]); api.compare(nums.slice(1)); return { kind: 'action', reply: `${nums[0].name} with ${nums.slice(1).map(t => t.name).join(' and ')} as ${nums.length > 2 ? 'ghosts' : 'a ghost'}.` }; }
    if (nums.length === 1 && nums[0] !== take) { api.compare([nums[0]]); return { kind: 'action', reply: `Comparing with ${nums[0].name}.` }; }
  }
  if (has(s, /\b(solo|just this one|only this|hide (the )?ghosts?|clear (the )?ghosts?|no ghosts?)\b/)) { api.compare([]); return { kind: 'action', reply: 'Showing only the selected take.' }; }
  if (has(s, /\bnext (take|one)\b/)) { const i = api.takes().indexOf(take); const t = api.takes()[(i + 1) % api.takes().length]; api.select(t); api.play(); return { kind: 'action', reply: `${t.name}.` }; }
  if (has(s, /\b(previous|last|prior) (take|one)\b/) && !has(s, /\b(delete|remove)\b/)) { const i = api.takes().indexOf(take); const t = api.takes()[(i - 1 + api.takes().length) % api.takes().length]; api.select(t); api.play(); return { kind: 'action', reply: `${t.name}.` }; }
  if (short && has(s, /\b(take|select|show|play|go to)\b/) && takeNumbers(s).length === 1 && !has(s, /\b(delete|remove|call|name|describe|explain|tell|what)\b/)) {
    const t = api.takes()[takeNumbers(s)[0] - 1];
    if (!t) return { kind: 'info', reply: `There’s no take ${takeNumbers(s)[0]}.` };
    api.select(t); api.play();
    return { kind: 'action', reply: `${t.name}.` };
  }

  // --- versions: duplicate, then retime by feeling
  const versionM = s.match(/\b(\w+) (version|variation|take|one)\b/);
  if (versionM && has(s, /\b(make|try|create|give me|do|show me|want|lets|let's)\b/) && feelingIn(versionM[1] + ' ')) {
    const f = feelingIn(versionM[1] + ' ');
    const src = take;
    const copy = api.edit(`${f} version`, () => {
      const c = api.duplicate(src, `${f[0].toUpperCase() + f.slice(1)} version of take ${api.takes().indexOf(src) + 1}`);
      applyFeeling(c, f);
      return c;
    });
    api.select(copy); api.compare([src]); api.play();
    return { kind: 'edit', reply: `Made “${copy.name}”: ${FEELINGS[f].note}. The original is the ghost.` };
  }

  // --- reading the takes
  const whichM = s.match(/\b(which|what) (one|take)?.*?\b(more|most|feels|is|reads|seems|looks)\b(.*)/);
  if (whichM || has(s, /\bwhich\b/)) {
    const f = feelingIn(s);
    if (f && f !== 'heavy' && f !== 'hesitant') {
      const pool = api.comparedWithSelected();
      const list = pool.length > 1 ? pool : api.takes();
      if (list.length < 2) return { kind: 'info', reply: 'I need at least two takes to compare.' };
      const ranked = list.map(t => ({ t, v: feelingScore(t, f) })).sort((a, b) => b.v - a.v);
      const [best, ...rest] = ranked;
      const second = rest[0];
      return {
        kind: 'info',
        reply: `${best.t.name} reads as more ${f}: ${feelingReasons(best.t)}. ${second.t.name} has ${feelingReasons(second.t)}. This is a reading of the timing only, so trust your eye over it.`,
      };
    }
  }
  if (has(s, /\b(differen|differ|vs|versus)\w*\b/)) {
    const pool = api.comparedWithSelected();
    if (pool.length < 2) return { kind: 'info', reply: 'Compare two takes first, for example “compare 1 and 2”.' };
    return { kind: 'info', reply: pool.map(t => `${t.name}: ${describe(t)}.`).join(' ') + ' ' + diffSentence(pool[0], pool[1]) };
  }
  if (has(s, /\b(describe|what happens|explain|tell me about|summar|break .*down|what did i do|read it)\w*\b/)) {
    const t = takeRef(s, api);
    if (!t) return { kind: 'info', reply: 'Select a take first.' };
    const m = metrics(t);
    return { kind: 'info', reply: `${t.name}, ${secs(m.duration)}: ${describe(t)}.` };
  }

  // --- names and removal
  const nameM = text.match(/\b(?:call|name|rename|label)\s+(?:it|this|this take|this one)?\s*(?:to|as)?\s*["“]?(.+?)["”]?\s*$/i);
  if (nameM && nameM[1] && take) {
    const name = nameM[1].trim().slice(0, 48);
    api.edit('rename', () => api.rename(take, name));
    return { kind: 'edit', reply: `Renamed to “${name}”.` };
  }
  if (has(s, /\b(delete|remove|throw away|discard|trash|bin)\b/) && has(s, /\b(take|this|it|one)\b/) && !has(s, /\b(pause|hold|hesitation)\b/)) {
    const t = takeRef(s, api);
    if (!t) return { kind: 'info', reply: 'Select the take to delete first.' };
    api.remove(t);
    return { kind: 'edit', reply: `Deleted “${t.name}”. Say “undo” to bring it back.` };
  }
  if (has(s, /\b(reset|original|as performed|as i performed|start over|clear (the )?edits)\b/)) {
    if (!take) return null;
    api.edit('reset', () => resetEdits(take));
    return { kind: 'edit', reply: `${take.name} is back to how you performed it.` };
  }

  // --- things this version can't do; say so instead of guessing
  if (has(s, /\b(bounce|bouncy|overshoot|wiggle|spin|rotate|rotation|bigger|smaller|scale|grow|shrink|squash|stretch the shape|color|colour|path|curve the|higher|lower|left|right)\b/) && !has(s, /\b(pause|hold|longer|shorter)\b/)) {
    return { kind: 'info', reply: 'That changes the shape of the path or the object itself. This version can only retime a take (durations, easing, speed, smoothing). Try performing it that way and comparing.' };
  }

  if (!take) return { kind: 'info', reply: 'Select a take first.' };

  // --- whole-take speed and smoothing
  const xM = s.match(/\b(\d+(?:\.\d+)?)\s?(x|×|times)\b/);
  const setSpeed = v => { api.edit('speed', () => { take.adjust = { ...take.adjust, speed: v }; }); return { kind: 'edit', reply: `${take.name} now plays at ${v}× (${secs(api.duration(take))}).` }; };
  if (has(s, /\bhalf[\s-]?speed\b/)) return setSpeed(0.5);
  if (has(s, /\b(double[\s-]?speed|twice as fast)\b/)) return setSpeed(2);
  if (xM && !pieceRef(s, take, api)) return setSpeed(Math.max(0.25, Math.min(3, +xM[1])));
  if (has(s, /\b(smoother|smooth it|less jitter|less shaky|cleaner|steadier)\b/) && !pieceRef(s, take, api)) {
    const before = effectiveSmoothing(take);
    api.edit('smoothing', () => { take.adjust = { ...take.adjust, smoothing: Math.min(1, before + 0.2) }; });
    return { kind: 'edit', reply: `Smoothing ${Math.round(before * 100)}% → ${Math.round(effectiveSmoothing(take) * 100)}%.` };
  }
  if (has(s, /\b(rawer|raw|rougher|more texture|less smooth|more jitter|grittier)\b/)) {
    const before = effectiveSmoothing(take);
    api.edit('smoothing', () => { take.adjust = { ...take.adjust, smoothing: Math.max(0, before - 0.2) }; });
    return { kind: 'edit', reply: `Smoothing ${Math.round(before * 100)}% → ${Math.round(effectiveSmoothing(take) * 100)}%.` };
  }

  // --- feelings on the selected take
  const f = feelingIn(s);
  const explicitPiece = /\b(pause|hold|hesitat\w*|entrance|entry|start|beginning|end|ending|exit|landing|piece|drift|moves?)\b/;
  if (f && !has(s, explicitPiece)) {
    const opposite = { nervous: 'confident', hesitant: 'confident', confident: 'hesitant', calm: 'urgent', urgent: 'calm', heavy: 'urgent' };
    const key = has(s, /\bless\b/) ? opposite[f] : f;
    const before = metrics(take);
    let note;
    api.edit(key, () => { note = applyFeeling(take, key); });
    const after = metrics(take);
    return { kind: 'edit', reply: `Retimed toward ${key}: ${note}. ${secs(before.duration)} → ${secs(after.duration)}.` };
  }

  // --- piece edits
  const pieces = pieceRef(s, take, api);
  const longer = /\b(longer|extend|stretch|lengthen|more|linger|hold it|wait longer|draw out|savou?r)\b/;
  const shorter = /\b(shorter|shorten|tighten|tighter|less|trim|quicker|briefer|reduce)\b/;
  const remove = /\b(remove|cut|drop|no|get rid of|lose|kill|skip|delete)\b/;
  const snappier = /\b(snappier|snappy|sharper|quicker|faster|punchier|crisper|tighter|zippier)\b/;
  const slower = /\b(slower|gentler|softer|lazier|smoother|easier|calmer|longer)\b/;

  if (pieces && pieces.length === 0) return { kind: 'info', reply: 'I couldn’t find that piece in this take. Say “describe” to hear its pieces.' };
  if (pieces && pieces.length) {
    const before = snapshotLabels(take, pieces);
    const isHold = pieces.every(p => p.kind === 'hold');
    if (isHold) {
      if (has(s, remove) && !has(s, longer)) api.edit('cut pause', () => pieces.forEach(p => setEdit(take, p.i, { scale: SCALE_MIN })));
      else if (has(s, shorter)) { const k = amount(s, false); api.edit('shorter pause', () => pieces.forEach(p => setEdit(take, p.i, { scale: editOf(take, p.i).scale * k }))); }
      else if (has(s, longer) || has(s, /\b(pause|hold|hesitat)\w*\b/)) { const k = amount(s, true); api.edit('longer pause', () => pieces.forEach(p => setEdit(take, p.i, { scale: editOf(take, p.i).scale * k }))); }
      else return null;
      api.selectPiece(pieces[0].i);
      return { kind: 'edit', reply: changeReport(take, before) + '.' };
    }
    if (has(s, /\bease[\s-]?out\b|\bsettle\b|\blands? softly\b/)) { api.edit('ease out', () => pieces.forEach(p => setEdit(take, p.i, { ease: 0.65 }))); api.selectPiece(pieces[0].i); return { kind: 'edit', reply: `${pieceName(take, pieces[0].i)} now starts fast and settles (ease out).` }; }
    if (has(s, /\bease[\s-]?in\b|\bbuild up\b|\bwind up\b/)) { api.edit('ease in', () => pieces.forEach(p => setEdit(take, p.i, { ease: -0.65 }))); api.selectPiece(pieces[0].i); return { kind: 'edit', reply: `${pieceName(take, pieces[0].i)} now starts slowly and builds (ease in).` }; }
    if (has(s, /\b(linear|even|steady|as performed)\b/)) { api.edit('even', () => pieces.forEach(p => setEdit(take, p.i, { ease: 0 }))); return { kind: 'edit', reply: 'Easing back to how you performed it.' }; }
    if (has(s, snappier)) { const k = has(s, /\b(much|lot|way|really)\b/) ? 0.5 : 0.7; api.edit('snappier', () => pieces.forEach(p => { const e = editOf(take, p.i); setEdit(take, p.i, { scale: e.scale * k, ease: e.ease + 0.4 }); })); api.selectPiece(pieces[0].i); return { kind: 'edit', reply: changeReport(take, before) + ', and it starts faster.' }; }
    if (has(s, slower)) { const k = has(s, /\b(much|lot|way|really)\b/) ? 2 : 1.4; api.edit('slower', () => pieces.forEach(p => { const e = editOf(take, p.i); setEdit(take, p.i, { scale: e.scale * k, ease: e.ease - 0.3 }); })); api.selectPiece(pieces[0].i); return { kind: 'edit', reply: changeReport(take, before) + ', with a softer start.' }; }
  }

  // whole-take speed words, last so piece phrases win
  if (has(s, /\b(slower|slow it down|slow down)\b/)) return setSpeed(Math.max(0.25, +(effectiveSpeed(take) * 0.75).toFixed(2)));
  if (has(s, /\b(faster|speed it up|quicker)\b/)) return setSpeed(Math.min(3, +(effectiveSpeed(take) * 1.33).toFixed(2)));

  // --- not a phrase this file knows
  return askClaude(text, take, api);
}


function diffSentence(a, b) {
  const ma = metrics(a), mb = metrics(b);
  const bits = [];
  const dh = ma.holdTotal - mb.holdTotal;
  if (Math.abs(dh) > 150) bits.push(`${dh > 0 ? a.name : b.name} spends ${secs(Math.abs(dh))} more standing still`);
  const dp = ma.peak - mb.peak;
  if (Math.abs(dp) > 0.3) bits.push(`${dp > 0 ? a.name : b.name} moves faster at its peak (${Math.max(ma.peak, mb.peak).toFixed(1)} vs ${Math.min(ma.peak, mb.peak).toFixed(1)} frames/s)`);
  const dd = ma.duration - mb.duration;
  if (Math.abs(dd) > 200) bits.push(`${dd > 0 ? a.name : b.name} is ${secs(Math.abs(dd))} longer`);
  return bits.length ? `In short: ${bits.join('; ')}.` : 'Their timing is very close.';
}

// Free-form phrases go to Claude when this page is hosted with it.
async function askClaude(text, take, api) {
  const sample = await api.claude();
  if (!sample) {
    return { kind: 'unknown', reply: `I don’t know “${text}” yet. Try “longer pause”, “snappier entrance”, “make a calm version”, or “help”.` };
  }
  const timing = timingOf(take);
  const prompt = [
    'You help a designer retime a recorded motion take in a motion-sketching tool.',
    'The take is split into pieces. You can only change timing: each piece\'s duration multiplier, each piece\'s ease (-1 starts slow and builds, 0 as performed, 1 starts fast and settles), the whole take\'s speed (0.25 to 3), or its smoothing (0 to 1). You cannot change the path, the shape, size, rotation or colour.',
    `Take "${take.name}", ${(timing[timing.length - 1].d1 / 1000).toFixed(2)} s, speed ${effectiveSpeed(take)}x, smoothing ${Math.round(effectiveSmoothing(take) * 100)}%.`,
    'Pieces:',
    ...timing.map(p => `${p.i}: ${p.kind}, ${((p.d1 - p.d0) / 1000).toFixed(2)} s, "${pieceLabel(take, p.i)}", duration multiplier ${p.scale.toFixed(2)}, ease ${p.ease.toFixed(2)}`),
    `The designer said: "${text}"`,
    'Reply with only JSON: {"reply": "one short plain sentence saying what you changed and why", "ops": [ {"op":"scale","piece":1,"factor":1.5}, {"op":"ease","piece":0,"value":0.6}, {"op":"speed","value":0.75}, {"op":"smoothing","value":0.4} ]}.',
    '"factor" multiplies the current duration. Use as few ops as needed. If timing changes cannot do what they asked, return "ops": [] and say plainly what they could try instead (for example, performing it again).',
  ].join('\n');
  api.thinking(true);
  try {
    const out = await sample.json(prompt, { modelTier: 'quick', cache: false });
    const ops = Array.isArray(out && out.ops) ? out.ops : [];
    if (ops.length) {
      api.edit('Claude edit', () => {
        for (const o of ops) {
          const p = timing[Number(o.piece)];
          if (o.op === 'scale' && p && isFinite(o.factor)) setEdit(take, p.i, { scale: editOf(take, p.i).scale * Number(o.factor) });
          if (o.op === 'ease' && p && isFinite(o.value)) setEdit(take, p.i, { ease: Number(o.value) });
          if (o.op === 'speed' && isFinite(o.value)) take.adjust = { ...take.adjust, speed: Math.max(0.25, Math.min(3, Number(o.value))) };
          if (o.op === 'smoothing' && isFinite(o.value)) take.adjust = { ...take.adjust, smoothing: Math.max(0, Math.min(1, Number(o.value))) };
        }
      });
    }
    return { kind: ops.length ? 'edit' : 'info', reply: String((out && out.reply) || 'Done.'), by: 'claude' };
  } catch (e) {
    const code = e && e.code;
    if (code === 'not_granted' || code === 'sampling_disabled') api.disableClaude();
    const why = code === 'not_granted' ? 'Claude isn’t allowed on this page' : code === 'rate_limited' ? 'Claude is busy; try again in a moment' : 'Claude couldn’t answer that';
    return { kind: 'unknown', reply: `${why}. Built-in phrases still work: “longer pause”, “snappier entrance”, “make a calm version”.` };
  } finally {
    api.thinking(false);
  }
}

export { piecesOf };
