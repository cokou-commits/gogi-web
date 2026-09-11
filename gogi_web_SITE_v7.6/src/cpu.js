'use strict';

const crypto = require('crypto');
const { NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, STEAL_AMOUNTS, POINT_TRANSFER_TURNS } = require('./rules');

const CPU_STYLES = ['aggressive', 'cautious', 'analyst', 'trickster'];
const COLOR_WORDS = ['赤', '青', '黄', '緑', '紫'];

function pick(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[crypto.randomInt(items.length)];
}

function chance(percent) {
  return crypto.randomInt(100) < percent;
}

function weightedPick(entries) {
  const valid = entries.filter(x => x && Number(x.weight) > 0);
  const total = valid.reduce((sum, x) => sum + Number(x.weight), 0);
  if (total <= 0) return null;
  let n = crypto.randomInt(total);
  for (const entry of valid) {
    if (n < entry.weight) return entry.value;
    n -= entry.weight;
  }
  return valid[valid.length - 1]?.value || null;
}

function otherAlive(room, p) {
  return room.players.filter(x => x.alive && x.playerId !== p.playerId);
}

function ensureCpuBrain(p) {
  if (!p.cpuBrain || typeof p.cpuBrain !== 'object') {
    p.cpuBrain = {
      style: pick(CPU_STYLES) || 'analyst',
      skill: 92 + crypto.randomInt(7),
      softAllies: {},
      lastObservedTurn: 0,
      attacksByColor: {},
      attackTargetsByColor: {},
      jointAttacksByColor: {},
      defensesByColor: {},
      specialsByColor: {},
      visibleDamageByColor: {},
      publicScoreEstimate: {},
      hostilityByColor: {},
      lastAttackTurnByColor: {},
      revealedObjectivesByColor: {},
      invalidObjectiveColors: {},
      repliesByTurn: {},
      chatsByTurn: {},
      pressureTargetId: null,
      pressureUntilTurn: 0,
      trustByPlayer: {},
      pactBrokenByPlayer: {},
      lastHumanSuggestionTurn: 0,
      lastChatTexts: [],
      purchasedSpecial: false
    };
  }
  const brain = p.cpuBrain;
  if (!Number.isInteger(brain.skill)) brain.skill = 94;
  for (const key of ['softAllies','attacksByColor','attackTargetsByColor','jointAttacksByColor','defensesByColor','specialsByColor','visibleDamageByColor','publicScoreEstimate','hostilityByColor','lastAttackTurnByColor','revealedObjectivesByColor','invalidObjectiveColors','repliesByTurn','chatsByTurn','trustByPlayer','pactBrokenByPlayer']) {
    if (!brain[key] || typeof brain[key] !== 'object') brain[key] = {};
  }
  if (!Array.isArray(brain.lastChatTexts)) brain.lastChatTexts = [];
  return brain;
}

function addAttackTarget(brain, color, target) {
  if (!color || !target) return;
  const list = brain.attackTargetsByColor[color] || [];
  if (!list.includes(target)) list.push(target);
  brain.attackTargetsByColor[color] = list.slice(-5);
}

// CPが利用する相手情報は、人間にも見える公開結果と自分自身の偵察結果だけに限定する。
// room内の相手points/objective/specials等の非公開値を戦略判断へ直接使わない。
function observePublicResult(room, p) {
  const brain = ensureCpuBrain(p);
  const result = room.lastResult;
  if (!result || !Number.isInteger(result.turn) || result.turn <= brain.lastObservedTurn) return brain;
  brain.lastObservedTurn = result.turn;

  let lastAttackers = [];
  let lastAttackTarget = '';
  for (const event of result.publicEvents || []) {
    const text = String(event?.text || '');
    if (event?.type === 'attack') {
      const m = text.match(/^(.+)の攻撃が(.+)に(\d+)ダメージ$/);
      if (m) {
        const attackers = m[1].split('・').filter(Boolean);
        const target = m[2];
        const damage = Number(m[3]) || 0;
        lastAttackers = attackers;
        lastAttackTarget = target;
        for (const color of attackers) {
          brain.attacksByColor[color] = (brain.attacksByColor[color] || 0) + 1;
          brain.publicScoreEstimate[color] = (brain.publicScoreEstimate[color] || 0) + 5;
          brain.lastAttackTurnByColor[color] = result.turn;
          addAttackTarget(brain, color, target);
          if (attackers.length >= 2) brain.jointAttacksByColor[color] = (brain.jointAttacksByColor[color] || 0) + 1;
          if (target === p.color?.label) {
            brain.hostilityByColor[color] = (brain.hostilityByColor[color] || 0) + damage + 1;
            const attackerPlayer = room.players.find(x => x.color?.label === color);
            if (attackerPlayer && activeSoftAlly(brain, attackerPlayer.playerId, result.turn)) {
              brain.pactBrokenByPlayer[attackerPlayer.playerId] = (brain.pactBrokenByPlayer[attackerPlayer.playerId] || 0) + 1;
              brain.trustByPlayer[attackerPlayer.playerId] = -3;
              brain.softAllies[attackerPlayer.playerId] = 0;
            }
          }
        }
        brain.visibleDamageByColor[target] = (brain.visibleDamageByColor[target] || 0) + damage;
      }
    } else if (event?.type === 'defense') {
      const m = text.match(/^(.+)が攻撃を防いだ$/);
      if (m) brain.defensesByColor[m[1]] = (brain.defensesByColor[m[1]] || 0) + 1;
    } else if (event?.type === 'special') {
      const m = text.match(/^(.+)が特殊カード/);
      if (m) brain.specialsByColor[m[1]] = (brain.specialsByColor[m[1]] || 0) + 1;
    } else if (event?.type === 'accusation') {
      const m = text.match(/告発成功。(.+)の秘密目標は「(.+)」/);
      if (m) {
        brain.invalidObjectiveColors[m[1]] = true;
        const obj = OBJECTIVES.find(x => x.label === m[2]);
        if (obj) brain.revealedObjectivesByColor[m[1]] = obj.key;
        const actors = text.split('の告発成功。')[0].split('・').filter(Boolean);
        for (const actor of actors) brain.publicScoreEstimate[actor] = (brain.publicScoreEstimate[actor] || 0) + 30;
      }
    } else if (event?.type === 'death' && lastAttackTarget) {
      const m = text.match(/^(.+)が脱落した$/);
      if (m && m[1] === lastAttackTarget) {
        for (const color of lastAttackers) {
          brain.hostilityByColor[color] = (brain.hostilityByColor[color] || 0) + 2;
          brain.publicScoreEstimate[color] = (brain.publicScoreEstimate[color] || 0) + (lastAttackers.length === 1 ? 20 : 10);
        }
      }
    }
  }
  return brain;
}

function latestScoutReport(p, targetId) {
  const reports = Array.isArray(p.scoutReports) ? p.scoutReports : [];
  for (let i = reports.length - 1; i >= 0; i--) {
    if (reports[i]?.targetId === targetId) return reports[i];
  }
  return null;
}

function strategicPick(scored, topChance = 90) {
  if (!scored.length) return null;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  if (sorted.length === 1 || chance(topChance)) return sorted[0].value;
  const pool = sorted.slice(0, Math.min(2, sorted.length));
  return pick(pool)?.value || sorted[0].value;
}

function eliteWeightedChoice(entries, p, fallbackTopChance = 91) {
  const valid = entries.filter(x => x && Number(x.weight) > 0);
  if (!valid.length) return null;
  const brain = ensureCpuBrain(p);
  const noise = brain.style === 'trickster' ? 10 : brain.style === 'aggressive' ? 7 : 4;
  const scored = valid.map(x => ({ value: x.value, score: Number(x.weight) + crypto.randomInt(noise + 1) }));
  const topChance = Math.max(fallbackTopChance, Math.min(98, Number(brain.skill || 94)));
  return strategicPick(scored, topChance);
}

function activeSoftAlly(brain, targetId, turn) {
  return Number(brain.softAllies?.[targetId] || 0) >= turn;
}

// 第10ターン以降は人間と同じく「自分が何位か」だけを戦略材料にしてよい。
// 他人の具体的なポイント値は返さず、CPの判断にも直接使わせない。
function ownVisibleRank(room, p) {
  if (!room || !p || Number(room.turn || 0) < 10) return null;
  const myPoints = Number(p.points || 0);
  const scores = room.players.map(x => Number(x.points || 0));
  const better = scores.filter(x => x > myPoints).length;
  const tied = scores.filter(x => x === myPoints).length;
  return { rank: better + 1, tied: tied > 1, total: scores.length };
}

function preferredAttackTarget(room, p) {
  const others = otherAlive(room, p);
  if (!others.length) return null;
  const brain = observePublicResult(room, p);

  if (p.objective?.key === 'reaper' && p.stats?.attackTargets?.length) {
    const first = p.stats.attackTargets[0];
    const target = others.find(x => x.playerId === first);
    if (target) return target;
  }

  const scored = others.map(target => {
    const report = latestScoutReport(p, target.playerId);
    let score = crypto.randomInt(18);
    if (p.stats?.attackedBy?.includes(target.playerId)) score += p.objective?.key === 'avenger' ? 62 : 28;
    if (report) {
      if (report.hp <= 1) score += 78;
      else if (report.hp === 2) score += 54;
      else if (report.hp === 3) score += 24;
      const defenseCount = Number(report.hand?.defense || 0);
      if (defenseCount === 0) score += 24;
      else if (defenseCount >= 3) score -= 8;
      if (Number(report.hand?.heal || 0) === 0) score += 7;
      const age = Math.max(0, room.turn - Number(report.turn || room.turn));
      score -= Math.min(24, age * 6);
    }
    const color = target.color?.label || '';
    score += Math.min(26, Number(brain.visibleDamageByColor[color] || 0) * 6);
    score += Math.min(18, Number(brain.attacksByColor[color] || 0) * 3);
    if (activeSoftAlly(brain, target.playerId, room.turn)) {
      const rank = ownVisibleRank(room, p);
      const endgamePressure = room.turn >= 13 ? 22 : room.turn >= 11 ? 10 : 0;
      const behindPressure = rank?.rank >= 4 ? 18 : 0;
      const betrayalChance = Math.min(82, (brain.style === 'trickster' ? 34 : 12) + endgamePressure + behindPressure);
      if (!chance(betrayalChance)) score -= 78;
    }
    if (brain.pressureTargetId === target.playerId && Number(brain.pressureUntilTurn || 0) >= room.turn) score += 34;
    if (Number(brain.pactBrokenByPlayer?.[target.playerId] || 0) > 0) score += 48;
    if (p.objective?.key === 'executioner' && report?.hp <= 2) score += 34;
    return { value: target, score };
  });
  return strategicPick(scored, ensureCpuBrain(p).style === 'analyst' ? 84 : 76);
}

function preferredScoutTarget(room, p) {
  const others = otherAlive(room, p);
  if (!others.length) return null;
  const brain = observePublicResult(room, p);
  const objective = p.objective?.key;

  if (objective === 'tracker' && p.stats?.scoutCounts) {
    const ranked = Object.entries(p.stats.scoutCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => others.find(x => x.playerId === id))
      .filter(Boolean);
    if (ranked.length) return ranked[0];
  }
  if (objective === 'observer' && p.stats?.scoutedTargets) {
    const unseen = others.filter(x => !p.stats.scoutedTargets.includes(x.playerId));
    if (unseen.length) return strategicPick(unseen.map(x => ({ value: x, score: 70 + crypto.randomInt(20) })), 90);
  }

  const scored = others.map(target => {
    const report = latestScoutReport(p, target.playerId);
    const age = report ? room.turn - Number(report.turn || room.turn) : 99;
    const color = target.color?.label || '';
    let score = report ? Math.min(50, Math.max(0, age) * 12) : 72;
    if (p.stats?.attackedBy?.includes(target.playerId)) score += 16;
    score += Math.min(18, Number(brain.attacksByColor[color] || 0) * 4);
    score += crypto.randomInt(16);
    return { value: target, score };
  });
  return strategicPick(scored, 82);
}

function objectiveBeliefs(room, p, target) {
  const brain = observePublicResult(room, p);
  const color = target?.color?.label || '';
  const attacks = Number(brain.attacksByColor[color] || 0);
  const attackTargets = brain.attackTargetsByColor[color] || [];
  const defenses = Number(brain.defensesByColor[color] || 0);
  const specials = Number(brain.specialsByColor[color] || 0);
  const joint = Number(brain.jointAttacksByColor[color] || 0);
  const usedObjectives = new Set([p.objective?.key, ...Object.values(brain.revealedObjectivesByColor || {})].filter(Boolean));
  const scores = Object.fromEntries(OBJECTIVES.map(o => [o.key, 8]));

  if (attacks >= 1) {
    scores.killer += attacks * 13;
    scores.executioner += attacks * 8;
    scores.avenger += attacks * 4;
    scores.accomplice += attacks * 4 + joint * 18;
  }
  if (attacks >= 2 && attackTargets.length === 1) scores.reaper += 72 + attacks * 8;
  if (attackTargets.length >= 2) scores.reaper -= 90;
  if (attacks >= 3 && Number(brain.lastAttackTurnByColor[color] || 0) >= room.turn - 1) scores.killer += 30;
  scores.ironWall += defenses * 23;
  if (defenses === 0 && room.turn >= 9) scores.ironWall -= 12;
  if (specials > 0) scores.hermit = -1000;
  else if (room.turn >= 10) scores.hermit += (room.turn - 9) * 8;

  // 公開情報だけでは直接読めない目標は低い事前確率を維持する。
  // ただし「各プレイヤーの秘密目標は重複しない」という公開ルールから、既知の割当だけ除外する。
  for (const key of usedObjectives) if (scores[key] != null) scores[key] = -1000;
  return OBJECTIVES.map(o => ({ value: o.key, score: scores[o.key] ?? 0 })).sort((a,b) => b.score - a.score);
}

function inferredObjective(room, p, target) {
  const beliefs = objectiveBeliefs(room, p, target).filter(x => x.score > -500);
  if (!beliefs.length) return pick(OBJECTIVES)?.key || null;
  const brain = ensureCpuBrain(p);
  const confidence = room.turn >= 10 ? Math.min(98, brain.skill + 2) : brain.skill;
  return strategicPick(beliefs, confidence);
}

function preferredAccusation(room, p) {
  const brain = observePublicResult(room, p);
  const candidates = otherAlive(room, p).filter(x => !brain.invalidObjectiveColors[x.color?.label || '']);
  if (!candidates.length) return { target: null, guess: null };
  const scored = candidates.map(target => {
    const beliefs = objectiveBeliefs(room, p, target);
    const best = beliefs[0]?.score || 0;
    const second = beliefs[1]?.score || 0;
    const evidenceGap = Math.max(0, best - second);
    const color = target.color?.label || '';
    const report = latestScoutReport(p, target.playerId);
    let score = best + evidenceGap * 1.4 + crypto.randomInt(8);
    score += Math.min(20, Number(brain.attacksByColor[color] || 0) * 4);
    if (report) score += Math.max(0, 12 - Math.max(0, room.turn - Number(report.turn || room.turn)) * 3);
    return { value: target, score };
  });
  const target = strategicPick(scored, Math.min(98, Number(brain.skill || 94)));
  return { target, guess: target ? inferredObjective(room, p, target) : null };
}

function preferredTarget(room, p, normal) {
  if (normal === 'attack') return preferredAttackTarget(room, p);
  if (normal === 'scout') return preferredScoutTarget(room, p);
  if (normal === 'accusation') return preferredAccusation(room, p).target;
  return pick(otherAlive(room, p));
}

function hasKnownVulnerableTarget(room, p) {
  return otherAlive(room, p).some(target => {
    const report = latestScoutReport(p, target.playerId);
    if (!report) return false;
    const age = room.turn - Number(report.turn || room.turn);
    return age <= 2 && report.hp <= 2;
  });
}

function chooseNormal(room, p) {
  const forced = p.forcedNormalType?.turn === room.turn ? p.forcedNormalType : null;
  const opponents = otherAlive(room, p);
  if (forced?.conflict) return null;
  if (forced?.type) {
    if ((p.hand[forced.type] || 0) <= 0) return null;
    if (['attack', 'scout', 'accusation'].includes(forced.type) && opponents.length === 0) return null;
    return forced.type;
  }
  if (opponents.length === 0) {
    if (p.hp < p.maxHp && (p.hand.heal || 0) > 0) return 'heal';
    if ((p.hand.defense || 0) > 0) return 'defense';
    return null;
  }

  const objective = p.objective?.key;
  const brain = observePublicResult(room, p);
  const weights = { attack: 42, defense: 22, scout: 20, accusation: 11, heal: p.hp <= 2 ? 70 : p.hp < p.maxHp ? 18 : 0 };
  if (brain.style === 'aggressive') { weights.attack += 16; weights.defense -= 3; }
  if (brain.style === 'cautious') { weights.defense += 15; weights.heal += 10; }
  if (brain.style === 'analyst') { weights.scout += 15; weights.accusation += 10; }
  if (brain.style === 'trickster') { weights.accusation += 10; weights.attack += 7; }

  const rank = ownVisibleRank(room, p);
  if (rank?.rank === 1) { weights.defense += 20; weights.heal += 10; weights.attack -= 5; }
  else if (rank?.rank >= 4) { weights.attack += 26; weights.accusation += 14; weights.scout += 6; }
  else if (rank?.rank === 3) { weights.attack += 10; weights.scout += 5; }

  if (p.hp <= 2) weights.defense += 32;
  if (room.turn >= 12 && p.hp <= 3) weights.defense += 16;
  if (hasKnownVulnerableTarget(room, p)) weights.attack += 38;
  const hostile = opponents.some(x => Number(brain.hostilityByColor[x.color?.label || ''] || 0) >= 2);
  if (hostile) weights.defense += p.hp <= 3 ? 20 : 8;

  if (objective === 'killer') {
    weights.attack += p.stats?.consecutiveAttackTurns >= 1 ? 72 : 42;
    if (p.stats?.consecutiveAttackTurns >= 2) weights.attack += 80;
  }
  if (objective === 'reaper') {
    const fixedId = p.stats?.attackTargets?.[0] || null;
    const fixedAlive = fixedId ? opponents.some(x => x.playerId === fixedId) : true;
    if (fixedId && !fixedAlive) weights.attack = 0;
    else weights.attack += 68;
  }
  if (objective === 'executioner') weights.attack += hasKnownVulnerableTarget(room, p) ? 95 : 44;
  if (objective === 'accomplice') weights.attack += brain.pressureTargetId ? 68 : 46;
  if (objective === 'avenger') weights.attack += p.stats?.attackedBy?.length ? 78 : 30;
  if (objective === 'ironWall') weights.defense += 70;
  if (objective === 'observer') {
    const unseen = opponents.filter(x => !p.stats?.scoutedTargets?.includes(x.playerId));
    weights.scout += unseen.length ? 92 : 15;
  }
  if (objective === 'tracker') {
    const hasTracked = Object.values(p.stats?.scoutCounts || {}).some(n => n >= 2);
    if (!hasTracked) weights.scout += 86;
  }
  if (objective === 'gambler') {
    weights.scout = 0;
    weights.accusation += room.turn >= 5 ? 88 : 36;
  }
  if (objective === 'nearDeath' && room.turn >= 13) {
    if (p.hp === 1) { weights.heal = 0; weights.defense += 120; weights.attack -= 10; }
    else if (p.hp === 2) { weights.heal = 0; weights.defense += 30; }
  }
  if (objective === 'endurer' && Number(p.stats?.damageTaken || 0) < 4 && p.hp >= 3 && room.turn <= 10) {
    weights.defense = Math.max(2, weights.defense - 18);
    weights.heal = Math.max(0, weights.heal - 8);
  }

  if (!opponents.some(x => !brain.invalidObjectiveColors[x.color?.label || ''])) weights.accusation = 0;
  const entries = Object.keys(weights).map(key => ({ value: key, weight: (p.hand[key] || 0) > 0 ? Math.max(0, weights[key]) : 0 }));
  return eliteWeightedChoice(entries, p, 92);
}

function preferredThreatTarget(room, p) {
  const others = otherAlive(room, p);
  if (!others.length) return null;
  const brain = observePublicResult(room, p);
  const scored = others.map(target => {
    const color = target.color?.label || '';
    let score = crypto.randomInt(18);
    if (p.stats?.attackedBy?.includes(target.playerId)) score += 34;
    score += Math.min(30, Number(brain.attacksByColor[color] || 0) * 7);
    score += Math.min(38, Math.max(0, Number(brain.publicScoreEstimate[color] || 0)) * 0.35);
    if (activeSoftAlly(brain, target.playerId, room.turn) && !chance(brain.style === 'trickster' ? 36 : 14)) score -= 60;
    return { value: target, score };
  });
  return strategicPick(scored, 80);
}

function chooseSpecial(room, p, normal) {
  if (p.objective?.key === 'hermit') return null;
  const opponents = otherAlive(room, p);
  const hasOpponents = opponents.length > 0;
  const available = Object.keys(SPECIAL_CARDS).filter(key => {
    if ((p.specials[key] || 0) <= 0) return false;
    if (!hasOpponents && ['cancel', 'specify', 'steal'].includes(key)) return false;
    return true;
  });
  if (!available.length) return null;
  const brain = observePublicResult(room, p);
  const rank = ownVisibleRank(room, p);

  if (available.includes('fullDefense')) {
    const threatened = opponents.some(x => Number(brain.hostilityByColor[x.color?.label || ''] || 0) >= 2);
    if (p.hp <= 1 || (p.hp <= 2 && (threatened || chance(92))) || (room.turn >= 13 && p.hp <= 3 && chance(78))) return 'fullDefense';
  }

  let useChance = 42;
  if (brain.style === 'aggressive') useChance += 4;
  if (brain.style === 'cautious') useChance -= 3;
  if (brain.style === 'trickster') useChance += 8;
  if (room.turn >= 10) useChance += 16;
  if (room.turn >= 13) useChance += 18;
  if (rank?.rank >= 4) useChance += 14;
  if (rank?.rank === 1 && p.hp >= 4) useChance -= 6;
  if (!chance(Math.min(94, Math.max(18, useChance)))) return null;

  const weights = [];
  for (const key of available) {
    if (key === 'double' && !normal) continue;
    let weight = 20;
    if (key === 'double') {
      if (normal === 'attack') weight = hasKnownVulnerableTarget(room, p) ? 100 : 48;
      else if (normal === 'heal') weight = p.hp <= 2 ? 82 : 18;
      else if (normal === 'accusation') weight = room.turn >= 8 ? 68 : 36;
      else if (normal === 'scout') weight = ['observer','tracker'].includes(p.objective?.key) ? 72 : 38;
      else if (normal === 'defense') weight = p.hp <= 2 ? 62 : 24;
    } else if (key === 'cancel') {
      weight = p.stats?.attackedBy?.length ? 72 : 42;
      if (p.hp <= 2) weight += 25;
    } else if (key === 'steal') {
      weight = room.turn >= 10 ? 82 : room.turn >= 6 ? 58 : 32;
      if (rank?.rank >= 4) weight += 20;
    } else if (key === 'specify') {
      weight = room.turn >= 9 ? 70 : 48;
    } else if (key === 'fullDefense') {
      weight = p.hp <= 3 ? 84 : 22;
    }
    weights.push({ value: key, weight });
  }
  return eliteWeightedChoice(weights, p, 94);
}

function chooseCpuDraft(room, p) {
  observePublicResult(room, p);
  const draft = {
    normal: null, special: null, normalTargetId: null, secondNormalTargetId: null,
    specialTargetId: null, accusationGuess: null, secondAccusationGuess: null,
    stealAmount: 25, specifiedType: null
  };
  if (!p?.alive) return draft;

  const normal = chooseNormal(room, p);
  draft.normal = normal;
  if (normal === 'attack' || normal === 'scout') draft.normalTargetId = preferredTarget(room, p, normal)?.playerId || null;
  else if (normal === 'accusation') {
    const accusation = preferredAccusation(room, p);
    draft.normalTargetId = accusation.target?.playerId || null;
    draft.accusationGuess = accusation.guess;
  }

  const special = chooseSpecial(room, p, normal);
  draft.special = special;
  if (['cancel', 'specify', 'steal'].includes(special)) draft.specialTargetId = preferredThreatTarget(room, p)?.playerId || null;

  if (special === 'specify') {
    const target = room.players.find(x => x.playerId === draft.specialTargetId);
    const report = target ? latestScoutReport(p, target.playerId) : null;
    const fresh = report && room.turn - Number(report.turn || room.turn) <= 2;
    if (fresh) {
      // 偵察で本人が合法的に知った手札だけを利用。低HP相手には回復/防御をさせず、攻撃的な相手には防御で縛る。
      const choices = [];
      for (const type of Object.keys(NORMAL_CARDS)) {
        if (Number(report.hand?.[type] || 0) <= 0) continue;
        let score = 10;
        if (report.hp <= 2 && ['attack','scout','accusation'].includes(type)) score += 55;
        if (type === 'defense') score += Number(ensureCpuBrain(p).attacksByColor[target.color?.label || ''] || 0) * 10;
        if (type === 'scout') score += 18;
        if (type === 'accusation') score += 12;
        if (type === 'heal') score -= report.hp <= 3 ? 40 : 0;
        choices.push({ value:type, score });
      }
      draft.specifiedType = strategicPick(choices, 97);
    }
    if (!draft.specifiedType) {
      draft.specifiedType = eliteWeightedChoice([
        { value:'defense', weight:40 }, { value:'scout', weight:30 }, { value:'attack', weight:18 },
        { value:'accusation', weight:9 }, { value:'heal', weight:3 }
      ], p, 94);
    }
  }
  if (special === 'steal') draft.stealAmount = 25;

  if (special === 'double' && normal === 'attack') {
    const primary = room.players.find(x => x.playerId === draft.normalTargetId);
    const candidates = otherAlive(room, p);
    if (primary && (p.objective?.key === 'reaper' || primary.hp <= 2 || chance(62))) {
      draft.secondNormalTargetId = primary.playerId;
    } else {
      const second = candidates.filter(x => x.playerId !== draft.normalTargetId);
      draft.secondNormalTargetId = (second.length ? preferredTarget({ ...room, players:[p, ...second] }, p, 'attack') : primary)?.playerId || draft.normalTargetId || null;
    }
  }
  if (special === 'double' && normal === 'scout') {
    const second = otherAlive(room, p).filter(x => x.playerId !== draft.normalTargetId);
    if (second.length) draft.secondNormalTargetId = strategicPick(second.map(x => ({ value:x, score: latestScoutReport(p, x.playerId) ? 20 : 80 })), 96)?.playerId || null;
  }
  if (special === 'double' && normal === 'accusation') {
    const brain = ensureCpuBrain(p);
    const second = otherAlive(room, p).filter(x => x.playerId !== draft.normalTargetId && !brain.invalidObjectiveColors[x.color?.label || '']);
    if (second.length) {
      const scored = second.map(x => ({ value:x, score:(objectiveBeliefs(room,p,x)[0]?.score || 0) + crypto.randomInt(6) }));
      const secondTarget = strategicPick(scored, 97);
      if (secondTarget) {
        draft.secondNormalTargetId = secondTarget.playerId;
        draft.secondAccusationGuess = inferredObjective(room, p, secondTarget);
      }
    }
  }
  return draft;
}

function falseHpValue(actual) {
  const choices = [0, 1, 2, 3, 4, 5].filter(x => x !== actual);
  return pick(choices) ?? ((actual + 1) % 6);
}

function cpuStructuredStatementPayload(room, p, draft = null) {
  if (!p?.alive) return null;
  const objective = p.objective?.key;

  // 詐欺師/正直者は秘密目標達成を狙って毎ターン確実に判定可能な発言をする。
  if (objective === 'liar') {
    return { subjectId: p.playerId, kind: 'hp', value: falseHpValue(Number(p.hp || 0)) };
  }
  if (objective === 'honest') {
    return { subjectId: p.playerId, kind: 'hp', value: Number(p.hp || 0) };
  }

  // それ以外は毎ターン必ず情報発言すると機械的に見えるため、自然な頻度に落とす。
  if (!chance(38)) return null;
  const tellTruth = chance(62);
  const modes = ['hp', 'kills', 'cardCount'];
  if (draft?.normal) modes.push('nextAction');
  const kind = pick(modes) || 'hp';

  if (kind === 'kills') {
    const actual = Number(p.stats?.soloKills || 0) + Number(p.stats?.jointKills || 0);
    return { subjectId: p.playerId, kind: 'kills', value: tellTruth ? actual : actual + 1 + crypto.randomInt(3) };
  }
  if (kind === 'cardCount') {
    const cardType = pick(Object.keys(NORMAL_CARDS)) || 'attack';
    const actual = Number(p.hand?.[cardType] || 0);
    const value = tellTruth ? actual : actual === 0 ? 1 : Math.max(0, actual + (chance(50) ? 1 : -1));
    return { subjectId: p.playerId, kind: 'cardCount', cardType, value };
  }
  if (kind === 'nextAction' && draft?.normal) {
    let normalType = draft.normal;
    if (!tellTruth) {
      const alternatives = ['none', ...Object.keys(NORMAL_CARDS)].filter(x => x !== draft.normal);
      normalType = pick(alternatives) || 'none';
    }
    return { subjectId: p.playerId, kind: 'nextAction', normalType };
  }

  const actual = Number(p.hp || 0);
  return { subjectId: p.playerId, kind: 'hp', value: tellTruth ? actual : falseHpValue(actual) };
}

function chooseCpuPurchasePlan(room, p) {
  if (!p?.alive) return null;
  const objective = p.objective?.key;
  const rank = ownVisibleRank(room, p);
  const points = Number(p.points || 0);
  const turnsLeft = Math.max(0, 15 - Number(room.turn || 1));
  const plans = [];

  // ポイント自体が勝敗なので、購入は「生存・秘密目標・終盤逆転」に価値がある時だけ行う。
  if (p.normalPurchasedTurn !== room.turn) {
    if (p.hp <= 2 && (p.hand.defense || 0) === 0 && points >= 20) plans.push({ type:'defense', score:96, cost:20 });
    if (p.hp <= 1 && (p.hand.heal || 0) === 0 && points >= 40 && objective !== 'nearDeath') plans.push({ type:'heal', score:94, cost:40 });
    if (['killer','reaper','executioner','accomplice','avenger'].includes(objective) && (p.hand.attack || 0) === 0 && points >= 20 && turnsLeft >= 1) plans.push({ type:'attack', score:82, cost:20 });
    if (objective === 'ironWall' && (p.hand.defense || 0) <= 1 && !p.secretState?.achieved && points >= 20) plans.push({ type:'defense', score:84, cost:20 });
    if (objective === 'observer' && new Set(p.stats?.scoutedTargets || []).size < 4 && (p.hand.scout || 0) === 0 && points >= 20) plans.push({ type:'scout', score:86, cost:20 });
    if (objective === 'tracker' && !Object.values(p.stats?.scoutCounts || {}).some(n => n >= 2) && (p.hand.scout || 0) === 0 && points >= 20) plans.push({ type:'scout', score:84, cost:20 });
    if (objective === 'gambler' && (p.hand.accusation || 0) === 0 && points >= 30 && room.turn >= 6) plans.push({ type:'accusation', score:80, cost:30 });
    if (rank?.rank >= 4 && room.turn >= 12 && (p.hand.attack || 0) === 0 && points >= 20) plans.push({ type:'attack', score:76, cost:20 });
  }

  // ランダム特殊50Pは高価。十分な余剰があり、追う展開か生存危機の時だけ買う。
  if (!p.specialPurchased && points >= 75 && objective !== 'hermit' && room.turn <= 13) {
    let score = 0;
    if (rank?.rank >= 4) score += 72;
    if (p.hp <= 2) score += 68;
    if (points >= 110) score += 18;
    if (score >= 72) plans.push({ type:'special', score, cost:50 });
  }
  if (!plans.length) return null;
  plans.sort((a,b) => b.score - a.score || a.cost - b.cost);
  const best = plans[0];
  // 1位時の無駄遣いを抑え、購入後に最低限のポイントを残す。
  const reserve = rank?.rank === 1 ? 20 : 5;
  if (points - best.cost < reserve && !(p.hp <= 1 && ['defense','heal'].includes(best.type))) return null;
  return best;
}

function chooseCpuPointTransfer(room, p) {
  if (!p?.alive || p.objective?.key !== 'giver') return null;
  if (!POINT_TRANSFER_TURNS.includes(room.turn) || Number(p.points || 0) < 5 || Number(p.stats?.pointTransfers || 0) > 0) return null;
  const candidates = otherAlive(room, p);
  if (!candidates.length) return null;
  const brain = ensureCpuBrain(p);
  const allies = candidates.filter(x => activeSoftAlly(brain, x.playerId, room.turn));
  const target = pick(allies.length ? allies : candidates);
  if (!target) return null;
  return { targetId: target.playerId, amount: 5 };
}

function labelOf(room, playerId) {
  return room.players.find(x => x.playerId === playerId)?.color?.label || '';
}

function cleanCpuText(text) {
  const out = String(text || '').replace(/\s+/g, ' ').trim();
  return out.slice(0, 120);
}

function chatIntentSummary(room, cpu, sender, rawText) {
  const text = String(rawText || '');
  const mentioned = mentionedPlayer(room, text);
  const mentionedColor = mentioned?.color?.label || '';
  if (/同盟|組も|組む|組ま|一緒|休戦|手を組/.test(text)) return `${sender.color?.label || '相手'}が非公式の共闘・休戦を提案した`;
  if (/攻撃|狙|殴|落と|倒/.test(text)) return mentionedColor
    ? `${sender.color?.label || '相手'}が${mentionedColor}への攻撃・警戒を話題にした`
    : `${sender.color?.label || '相手'}が攻撃先について話した`;
  if (/HP|体力/.test(text)) return `${sender.color?.label || '相手'}がHP情報について話した`;
  if (/嘘|怪し|信用|信じ/.test(text)) return `${sender.color?.label || '相手'}が嘘・信用について話した`;
  if (/告発|目標/.test(text)) return `${sender.color?.label || '相手'}が秘密目標・告発について話した`;
  if (/偵察|情報/.test(text)) return `${sender.color?.label || '相手'}が偵察・情報について話した`;
  if (/ポイント|順位/.test(text)) return `${sender.color?.label || '相手'}がポイント・順位について話した`;
  return `${sender.color?.label || '相手'}がCPに話しかけた`;
}

// 会話を「演出だけ」にせず、公開チャットの提案を現在の行動案へ一定確率で反映する。
// 強制カード・秘密情報を破る変更は行わず、人間と同じ公開情報だけで反応する。
function adaptCpuDraftFromChat(room, cpu, sender, rawText) {
  if (!room || !cpu?.isCpu || !cpu.alive || !sender?.alive || room.phase !== 'chat') return false;
  const text = String(rawText || '');
  const brain = observePublicResult(room, cpu);
  const forced = cpu.forcedNormalType?.turn === room.turn ? cpu.forcedNormalType : null;
  const mentioned = mentionedPlayer(room, text);
  let changed = false;

  if (/同盟|組も|組む|組ま|一緒|休戦|手を組/.test(text)) {
    const acceptChance = brain.style === 'trickster' ? 82 : brain.style === 'analyst' ? 68 : 62;
    if (chance(acceptChance)) {
      brain.softAllies[sender.playerId] = Math.max(Number(brain.softAllies[sender.playerId] || 0), room.turn + 2);
      brain.trustByPlayer[sender.playerId] = Math.min(5, Number(brain.trustByPlayer[sender.playerId] || 0) + 1);
      if (!forced && cpu.draft?.normal === 'attack' && cpu.draft.normalTargetId === sender.playerId) {
        const alternatives = otherAlive(room, cpu).filter(x => x.playerId !== sender.playerId);
        const alt = alternatives.length ? strategicPick(alternatives.map(x => ({ value:x, score:crypto.randomInt(25) + 20 })), 85) : null;
        if (alt) { cpu.draft.normalTargetId = alt.playerId; changed = true; }
        else if ((cpu.hand.defense || 0) > 0) { cpu.draft.normal = 'defense'; cpu.draft.normalTargetId = null; changed = true; }
      }
    }
  }

  if (/攻撃|狙|殴|落と|倒/.test(text) && mentioned && mentioned.playerId !== cpu.playerId && mentioned.alive) {
    brain.pressureTargetId = mentioned.playerId;
    brain.pressureUntilTurn = room.turn;
    brain.lastHumanSuggestionTurn = room.turn;
    const ally = activeSoftAlly(brain, mentioned.playerId, room.turn);
    const coordinateChance = brain.style === 'analyst' ? 74 : brain.style === 'aggressive' ? 80 : brain.style === 'trickster' ? 67 : 61;
    if (!ally && chance(coordinateChance) && !forced) {
      if (cpu.draft?.normal === 'attack' && (cpu.hand.attack || 0) > 0) {
        cpu.draft.normalTargetId = mentioned.playerId; changed = true;
      } else if (cpu.draft?.normal === 'scout' && (cpu.hand.scout || 0) > 0) {
        cpu.draft.normalTargetId = mentioned.playerId; changed = true;
      }
    }
  }

  // 自分への攻撃予告を含む会話は防御寄りに修正する。
  const myColor = cpu.color?.label || '';
  if (myColor && text.includes(myColor) && /攻撃|狙|殴|落と|倒/.test(text) && !forced && (cpu.hand.defense || 0) > 0 && chance(72)) {
    cpu.draft.normal = 'defense';
    cpu.draft.normalTargetId = null;
    cpu.draft.accusationGuess = null;
    cpu.draft.secondNormalTargetId = null;
    cpu.draft.secondAccusationGuess = null;
    changed = true;
  }
  return changed;
}

function cpuOpeningChatPlan(room, p, draft) {
  if (!p?.alive) return [];
  const brain = observePublicResult(room, p);
  const plans = [];
  const targetLabel = labelOf(room, draft?.normalTargetId);
  const attacker = otherAlive(room, p).find(x => p.stats?.attackedBy?.includes(x.playerId));
  const betrayer = otherAlive(room, p).find(x => Number(brain.pactBrokenByPlayer?.[x.playerId] || 0) > 0);

  if (betrayer && chance(78)) {
    const c = betrayer.color?.label || '';
    plans.push({ text: pick([
      `${c}、さっきの約束はもうなしな`,
      `${c}は一回組んだのに殴ってきたから信用しない`,
      `${c}はもう警戒でいいと思う`
    ]), toId:null, intent:'callout_betrayal' });
  } else if (p.hp <= 2 && chance(66)) {
    plans.push({ text: pick([
      '今俺狙うより他見た方がいいと思う',
      'ちょっと削られてる。今ターンは様子見たい',
      '今俺に攻撃集めるのはやめない？'
    ]), toId: null });
  } else if (attacker && chance(48)) {
    const c = attacker.color?.label || '';
    plans.push({ text: pick([
      `${c}さっき俺殴ったよな。ちょっと警戒してる`,
      `${c}は一回見ておきたい`,
      `${c}の動きちょっと気になる`
    ]), toId: null });
  } else if (draft?.normal === 'attack' && targetLabel) {
    if (p.objective?.key === 'accomplice' && chance(78)) {
      plans.push({ text: pick([
        `${targetLabel}に一回合わせない？`,
        `${targetLabel}削るなら今合わせたい`,
        `${targetLabel}に圧集めるのありじゃない？`
      ]), toId: null, intent:'coordinate_attack' });
    } else if (chance(brain.style === 'trickster' ? 43 : 24)) {
      plans.push({ text: pick([
        '今ターンは攻撃しないつもり',
        '俺は一回情報取りに行く',
        '今は殴り合うターンじゃないと思ってる'
      ]), toId: null });
    } else {
      plans.push({ text: pick([
        `${targetLabel}ちょっと怖くない？`,
        `${targetLabel}一回見た方がいいと思う`,
        `${targetLabel}に圧かけるのはあり`
      ]), toId: null });
    }
  } else if (draft?.normal === 'scout' && chance(58)) {
    plans.push({ text: pick([
      '一回情報取りに行く。結果見てから考える',
      '今ターンは様子見寄り',
      'まだ殴るより情報欲しい'
    ]), toId: null });
  } else if (draft?.normal === 'accusation' && chance(60)) {
    plans.push({ text: pick([
      'そろそろ目標読めそうな人いるな',
      '告発狙える気がする',
      '動き方で目標ちょっと見えてきた'
    ]), toId: null });
  } else if (chance(68)) {
    plans.push({ text: pick([
      'みんな今誰見てる？',
      'このターン結構分かれそう',
      'まだ決め切ってない',
      '情報ある人いる？'
    ]), toId: null });
  }

  // ときどき非公式の共闘・休戦を持ちかける。これはゲーム上の正式同盟ではない。
  if (plans.length < 3 && chance(brain.style === 'trickster' ? 52 : brain.style === 'analyst' ? 34 : 28)) {
    const candidates = otherAlive(room, p).filter(x => x.playerId !== draft?.normalTargetId);
    const ally = pick(candidates);
    if (ally) {
      brain.softAllies[ally.playerId] = Math.max(Number(brain.softAllies[ally.playerId] || 0), room.turn + 2);
      const c = ally.color?.label || '';
      plans.push({ text: pick([
        `${c}とは今ターンぶつからなくていいと思ってる`,
        `${c}、一旦お互い触らないでいかない？`,
        `${c}とは今はやり合う必要なさそう`
      ]), toId: null });
    }
  }

  const rank = ownVisibleRank(room, p);
  if (plans.length < 3 && rank && chance(58)) {
    if (rank.rank === 1) plans.push({ text: pick(['終盤だし無理に動く必要はなさそう', '今は変にヘイト買いたくない', '終盤、誰が仕掛けるか見たい']), toId:null });
    else if (rank.rank >= 4) plans.push({ text: pick(['終盤だしそろそろ動く', 'このままじゃまずいから仕掛けるかも', '順位的に守ってる場合じゃない']), toId:null });
  }

  return plans.slice(0, 3).map((plan, index) => ({
    text: cleanCpuText(plan.text),
    toId: plan.toId || null,
    intent: plan.intent || 'strategy',
    delayMs: index === 0 ? 350 + crypto.randomInt(1200) : index === 1 ? 2400 + crypto.randomInt(3000) : 5600 + crypto.randomInt(3600)
  })).filter(x => x.text);
}

function mentionedPlayer(room, text) {
  for (const player of room.players) {
    const label = player.color?.label;
    if (label && text.includes(label)) return player;
  }
  return null;
}

function cpuReplyToChat(room, cpu, sender, rawText, { direct = false } = {}) {
  if (!cpu?.alive || !sender?.alive) return null;
  const text = String(rawText || '').trim();
  if (!text) return null;
  const brain = ensureCpuBrain(cpu);
  const key = String(room.turn);
  const replies = Number(brain.repliesByTurn[key] || 0);
  if (replies >= 4) return null;

  const myColor = cpu.color?.label || 'CP';
  const addressed = direct || text.includes(myColor);
  const strategic = /同盟|組も|組む|組ま|一緒|攻撃|狙|殴|守|HP|ポイント|嘘|怪し|告発|偵察/.test(text);
  if (!addressed && !strategic && !chance(24)) return null;
  if (!addressed && !chance(strategic ? 68 : 24)) return null;
  adaptCpuDraftFromChat(room, cpu, sender, text);

  let reply = '';
  let acceptedPact = false;
  if (/同盟|組も|組む|組ま|一緒/.test(text)) {
    if (chance(brain.style === 'trickster' ? 76 : 62)) {
      acceptedPact = true;
      brain.softAllies[sender.playerId] = Math.max(Number(brain.softAllies[sender.playerId] || 0), room.turn + 2);
      reply = pick(['いいよ。一旦合わせよう', '今ターンはそれでいこう', 'あり。とりあえず今は敵対しない']);
    } else {
      reply = pick(['まだそこまでは決めたくない', '一旦様子見たい', '今は保留で']);
    }
  } else if (/攻撃|狙|殴/.test(text)) {
    const mentioned = mentionedPlayer(room, text);
    const c = mentioned?.color?.label;
    reply = c && c !== myColor
      ? pick([`${c}は確かに気になる`, `${c}見るのはあり`, `それなら${c}は警戒する`])
      : pick(['誰に集めるか次第だな', '今ターンはまだ読ませたくない', '攻撃先はちょっと考える']);
  } else if (/HP/.test(text)) {
    reply = pick(['そのHP情報どこまで信用していい？', 'それ本当なら結構でかい', 'HP情報は一旦覚えとく']);
  } else if (/嘘|怪し/.test(text)) {
    reply = pick(['それ言うなら逆に怪しい', 'まあ全部は信じてない', 'その線はあると思う']);
  } else if (/告発|目標/.test(text)) {
    reply = pick(['目標読みはまだ半信半疑', '告発は外すとテンポきついな', '動き見ればそろそろ絞れそう']);
  } else if (/偵察|情報/.test(text)) {
    reply = pick(['情報あるなら欲しい', '偵察結果は結構大事', '誰見たかは気になる']);
  } else {
    reply = pick(['了解', '一旦信じる', 'それは分かる', 'まだ何とも言えない']);
  }

  brain.repliesByTurn[key] = replies + 1;
  return {
    text: cleanCpuText(reply),
    toId: direct ? sender.playerId : null,
    delayMs: 900 + crypto.randomInt(2400),
    acceptedPact,
    triggerSummary: chatIntentSummary(room, cpu, sender, text),
    intent: acceptedPact ? 'pact' : strategic ? 'strategy_reply' : 'casual_reply'
  };
}

module.exports = {
  chooseCpuDraft,
  cpuStructuredStatementPayload,
  chooseCpuPointTransfer,
  chooseCpuPurchasePlan,
  cpuOpeningChatPlan,
  cpuReplyToChat,
  adaptCpuDraftFromChat,
  ownVisibleRank,
  ensureCpuBrain,
  objectiveBeliefs
};
