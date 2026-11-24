'use strict';
// option value is the name, not the index, otherwise a config change hits the wrong subteam

const MAX_VALUE = 100; // discord limit for select values

function subteamValue(subteam) {
  return String(subteam && subteam.name).slice(0, MAX_VALUE);
}

function subteamOptions(subteams) {
  return (subteams || []).map((s) => ({ label: s.name, value: subteamValue(s) }));
}

// null if renamed/deleted meanwhile
function findSubteam(subteams, value) {
  return (subteams || []).find((s) => subteamValue(s) === String(value)) || null;
}

module.exports = { subteamOptions, findSubteam };
