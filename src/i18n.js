// -----------------------------------------------------------------------------
// The texts shown to the user (feature names, connection status, action
// answers, command refusals), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** The text of a `{ en, fr }` in a language (French when missing). */
export const word = (text, language) => text?.[language] ?? text?.fr ?? String(text ?? '');

/** `{ en, fr }` -> one text with both, for the status and the action answers. */
export const join = (parts, separator = ' ') => ({
  en: parts.map((p) => p.en).join(separator),
  fr: parts.map((p) => p.fr).join(separator),
});

export const FEATURE_NAMES = {
  door: both('Gate or garage door', 'Portail ou porte de garage'),
  open: both('Open', 'Ouvrir'),
  close: both('Close', 'Fermer'),
};

const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

const CLOSE_DROPPED = {
  expired: both(
    'the Remootio could not be reached within 2 minutes',
    'le Remootio n’a pas pu être joint en 2 minutes',
  ),
  movedOffline: both(
    'the door moved while the connection was down',
    'la porte a bougé pendant la coupure',
  ),
  otherKey: both('another key operated the door', 'une autre clé a actionné la porte'),
  relayBusy: both('the output was being driven', 'la sortie était en train d’être actionnée'),
  closeOff: both('closing disabled', 'fermeture désactivée'),
  tries: both('3 tries without success', '3 essais sans succès'),
};

const KEY_NAMES = {
  secret: both('API Secret Key', 'API Secret Key'),
  auth: both('API Auth Key', 'API Auth Key'),
};

export const T = {
  none: both(
    'No Remootio yet: type its IP address and its two API keys in the configuration.',
    'Aucun Remootio pour le moment : saisissez son adresse IP et ses deux clés d’API dans la configuration.',
  ),
  configUnreadable: (waitMs) =>
    both(
      `The configuration could not be read from Gladys: trying again in ${seconds(waitMs)} s.`,
      `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${seconds(waitMs)} s.`,
    ),
  hostMissing: (slot) =>
    both(`Remootio ${slot}: no IP address.`, `Remootio ${slot} : pas d’adresse IP.`),
  hostInvalid: (slot) =>
    both(
      `Remootio ${slot}: the address is not an IP address nor a host name.`,
      `Remootio ${slot} : l’adresse n’est ni une adresse IP ni un nom d’hôte.`,
    ),
  keyMissing: (slot, which) =>
    both(
      `Remootio ${slot}: no ${KEY_NAMES[which].en}.`,
      `Remootio ${slot} : pas d’${KEY_NAMES[which].fr}.`,
    ),
  keyInvalid: (slot, which, length) =>
    both(
      `Remootio ${slot}: the ${KEY_NAMES[which].en} is not 64 hexadecimal digits (${length} characters typed).`,
      `Remootio ${slot} : l’${KEY_NAMES[which].fr} n’est pas faite de 64 chiffres hexadécimaux (${length} caractères saisis).`,
    ),
  connected: (slot, address, serial) =>
    both(
      `Remootio ${slot} (${address}, ${serial}): connected.`,
      `Remootio ${slot} (${address}, ${serial}) : connecté.`,
    ),
  connecting: (slot, address) =>
    both(
      `Remootio ${slot} (${address}): connecting…`,
      `Remootio ${slot} (${address}) : connexion…`,
    ),
  down: (slot, address, reason, waitMs) =>
    both(
      `Remootio ${slot} (${address}): not connected (${reason.en}), next try in ${seconds(waitMs)} s.`,
      `Remootio ${slot} (${address}) : non connecté (${reason.fr}), nouvel essai dans ${seconds(waitMs)} s.`,
    ),
  refused: (slot, address) =>
    both(
      `Remootio ${slot} (${address}): the API keys were refused (twice in a row, the Remootio answered with a challenge these keys cannot open). No more tries: check both keys in the Remootio app (Device software, Websocket API) and save the right ones, or use "Check the Remootio devices".`,
      `Remootio ${slot} (${address}) : les clés d’API ont été refusées (deux fois de suite, le Remootio a répondu par un défi que ces clés n’ouvrent pas). Plus aucun essai : vérifiez les deux clés dans l’application Remootio (Device software, Websocket API) et enregistrez les bonnes, ou utilisez « Vérifier les Remootio ».`,
    ),
  otherDevice: (slot, address, serial) =>
    both(
      `Remootio ${slot} (${address}): another Remootio (…${serial.slice(-6)}) answers at this address and these keys do not open it: check the address (a fixed IP address in your router). Tried again as usual.`,
      `Remootio ${slot} (${address}) : un autre Remootio (…${serial.slice(-6)}) répond à cette adresse et ces clés ne l’ouvrent pas : vérifiez l’adresse (une adresse IP fixe dans votre box). Nouvel essai comme d’habitude.`,
    ),
  closeDropped: (name, why) =>
    both(
      `${name}: the kept close did not leave (${(CLOSE_DROPPED[why] ?? CLOSE_DROPPED.expired).en}).`,
      `${name} : la fermeture gardée n’est pas partie (${(CLOSE_DROPPED[why] ?? CLOSE_DROPPED.expired).fr}).`,
    ),
  replaced: (slot, previous, next) =>
    both(
      `Remootio ${slot}: ${next} answers with these keys where ${previous} was; ${previous} is no longer commanded.`,
      `Remootio ${slot} : ${next} répond avec ces clés là où était ${previous} ; ${previous} n’est plus commandé.`,
    ),
  commandsOff: both(
    'Commands off ("Allow opening" and "Allow closing"): the doors are only read, Open and Close are refused.',
    'Commandes désactivées (« Autoriser l’ouverture » et « Autoriser la fermeture ») : les portes sont seulement lues, Ouvrir et Fermer sont refusés.',
  ),
  openOff: both(
    'Opening off ("Allow opening"): Open is refused.',
    'Ouverture désactivée (« Autoriser l’ouverture ») : Ouvrir est refusé.',
  ),
  closeOff: both(
    'Closing off ("Allow closing"): Close is refused.',
    'Fermeture désactivée (« Autoriser la fermeture ») : Fermer est refusé.',
  ),
  notReached: (name, expected) =>
    expected === 'unread'
      ? both(
          `${name}: state not read after the last command (no connection): check the gate or door.`,
          `${name} : état non relu après la dernière commande (pas de connexion) : vérifiez le portail ou la porte.`,
        )
      : both(
          `${name}: not read ${expected === 'open' ? 'open' : 'closed'} after the last command (an obstacle, the remote, or a longer travel time than configured).`,
          `${name} : pas lu ${expected === 'open' ? 'ouvert' : 'fermé'} après la dernière commande (un obstacle, la télécommande, ou une course plus longue que celle configurée).`,
        ),
  reasons: {
    connect: both('no connection', 'pas de connexion'),
    timeout: both('no answer in time', 'pas de réponse à temps'),
    identity: both(
      'no serial number in its answer: Remootio software older than 2.21? Update it in the app',
      'pas de numéro de série dans sa réponse : logiciel du Remootio antérieur à 2.21 ? Mettez-le à jour dans l’application',
    ),
    auth: both('authentication refused', 'authentification refusée'),
    protocol: both('frame not understood', 'trame non comprise'),
    closed: both('connection lost', 'connexion perdue'),
    otherDevice: both('another Remootio at this address', 'un autre Remootio à cette adresse'),
    device: both('error frame', 'trame d’erreur'),
    notSent: both('connection closed', 'connexion fermée'),
  },
  check: {
    result: (lines) => both(lines.map((l) => l.en).join('\n'), lines.map((l) => l.fr).join('\n')),
    tooSoon: (waitMs) =>
      both(
        `Refused keys are tried again at most every 30 s: wait ${seconds(waitMs)} s.`,
        `Les clés refusées sont réessayées au plus toutes les 30 s : attendez ${seconds(waitMs)} s.`,
      ),
  },
};

/** The command refusals and errors (one language, the configured one). */
export const ERRORS = {
  readOnly: both('This feature cannot be controlled.', 'Cette fonctionnalité ne se commande pas.'),
  badValue: both('Invalid value.', 'Valeur invalide.'),
  unknownDevice: both(
    'This Remootio is not in the configuration any more (or another one answers with its keys): nothing sent.',
    'Ce Remootio n’est plus dans la configuration (ou un autre répond avec ses clés) : rien n’a été envoyé.',
  ),
  openDisabled: both(
    'Opening is disabled in the configuration ("Allow opening"): nothing sent.',
    'L’ouverture est désactivée dans la configuration (« Autoriser l’ouverture ») : rien n’a été envoyé.',
  ),
  closeDisabled: both(
    'Closing is disabled in the configuration ("Allow closing"): nothing sent. Closing is the same pulse as opening, so it has its own option.',
    'La fermeture est désactivée dans la configuration (« Autoriser la fermeture ») : rien n’a été envoyé. Fermer est la même impulsion qu’ouvrir : il a sa propre option.',
  ),
  noKeys: both(
    'The API keys or the address of this Remootio are missing or invalid in the configuration: nothing sent.',
    'Les clés d’API ou l’adresse de ce Remootio manquent ou sont invalides dans la configuration : rien n’a été envoyé.',
  ),
  keysRefused: both(
    'This Remootio refused the API keys: nothing sent. Check both keys, then save them again.',
    'Ce Remootio a refusé les clés d’API : rien n’a été envoyé. Vérifiez les deux clés, puis enregistrez-les à nouveau.',
  ),
  cancelled: both(
    'Cancelled by a close command: nothing sent.',
    'Annulée par une commande de fermeture : rien n’a été envoyé.',
  ),
  busy: both(
    'Another command of this Remootio is in progress: nothing sent.',
    'Une autre commande de ce Remootio est en cours : rien n’a été envoyé.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: nothing sent.',
    'La configuration a changé entre-temps : rien n’a été envoyé.',
  ),
  tooSlow: (reason) =>
    both(
      `The Remootio could not be reached in time (${reason.en}): nothing sent.`,
      `Le Remootio n’a pas pu être joint à temps (${reason.fr}) : rien n’a été envoyé.`,
    ),
  closeKept: (reason) =>
    both(
      `The Remootio could not be reached in time (${reason.en}): nothing sent yet. The close is kept and sent at the next connection (within 2 minutes, 3 tries at most).`,
      `Le Remootio n’a pas pu être joint à temps (${reason.fr}) : rien n’a encore été envoyé. La fermeture est gardée et envoyée à la prochaine connexion (dans les 2 minutes, 3 essais au plus).`,
    ),
  saveFailed: both(
    'The guard of the pulse could not be saved to /data: nothing sent.',
    'La garde de l’impulsion n’a pas pu être enregistrée dans /data : rien n’a été envoyé.',
  ),
  noSensor: both(
    'This Remootio has no status sensor: it refuses Open and Close (a blind pulse could do the opposite), nothing moved.',
    'Ce Remootio n’a pas de capteur d’état : il refuse Ouvrir et Fermer (une impulsion à l’aveugle pourrait faire l’inverse), rien n’a bougé.',
  ),
  relayBusy: (waitMs) =>
    both(
      `The output of the Remootio is being driven right now (another key, or its manual button): the gate or door is about to move, nothing was sent. Try again after the travel (${seconds(waitMs)} s).`,
      `La sortie du Remootio est en train d’être actionnée (une autre clé, ou son bouton manuel) : le portail ou la porte va bouger, rien n’a été envoyé. Réessayez après la course (${seconds(waitMs)} s).`,
    ),
  configNotLoaded: both(
    'The configuration is not loaded yet (asked again to Gladys): nothing sent.',
    'La configuration n’est pas encore chargée (redemandée à Gladys) : rien n’a été envoyé.',
  ),
  refused: (code) =>
    both(
      `The Remootio refused the command (${code}): nothing moved.`,
      `Le Remootio a refusé la commande (${code}) : rien n’a bougé.`,
    ),
  justCommanded: (waitMs) =>
    both(
      `The gate or door was operated just now and may still be moving: another pulse would stop or reverse it, so nothing was sent. Try again in ${seconds(waitMs)} s, or use the remote control.`,
      `Le portail ou la porte vient d’être actionné et bouge peut-être encore : une autre impulsion l’arrêterait ou l’inverserait, rien n’a donc été envoyé. Réessayez dans ${seconds(waitMs)} s, ou utilisez la télécommande.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason.en}): check the gate or door in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason.fr}) : vérifiez le portail ou la porte dans quelques secondes.`,
    ),
};
