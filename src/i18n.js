// -----------------------------------------------------------------------------
// Every text the user reads (status, buttons, scene errors), in English and
// French. Never the URL of the webhook, a token nor the text of a message.
// -----------------------------------------------------------------------------

const join = (...parts) => ({
  en: parts.map((p) => p.en).join(' '),
  fr: parts.map((p) => p.fr).join(' '),
});

const BLOCKERS = {
  url_missing: {
    en: 'Paste the URL of the incoming webhook of Synology Chat in the configuration.',
    fr: "Collez l'URL du webhook entrant de Synology Chat dans la configuration.",
  },
  url_invalid: {
    en: 'The URL of the incoming webhook cannot be read: copy it again from Synology Chat.',
    fr: "L'URL du webhook entrant est illisible : copiez-la de nouveau depuis Synology Chat.",
  },
  url_scheme: {
    en: 'The URL of the incoming webhook must start with https:// (or http://).',
    fr: "L'URL du webhook entrant doit commencer par https:// (ou http://).",
  },
  url_credentials: {
    en: 'The URL of the incoming webhook must not hold a user name or a password.',
    fr: "L'URL du webhook entrant ne doit contenir ni utilisateur ni mot de passe.",
  },
  url_address: {
    en: 'The address of the URL is a broadcast, multicast or unspecified address.',
    fr: "L'adresse de l'URL est une adresse de diffusion, de multidiffusion ou non spécifiée.",
  },
  url_not_incoming: {
    en: 'This is not the URL of an incoming webhook of Synology Chat (…/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming…&token=…).',
    fr: "Ce n'est pas l'URL d'un webhook entrant de Synology Chat (…/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming…&token=…).",
  },
  http_refused: {
    en: 'The URL starts with http://: the token would cross the network in clear. Use the https:// URL, or tick "Allow HTTP".',
    fr: "L'URL commence par http:// : le jeton passerait en clair sur le réseau. Utilisez l'URL en https://, ou cochez « Autoriser HTTP ».",
  },
  fingerprint_invalid: {
    en: 'The certificate fingerprint is not a SHA-256 fingerprint (64 hexadecimal digits).',
    fr: "L'empreinte du certificat n'est pas une empreinte SHA-256 (64 chiffres hexadécimaux).",
  },
};

const INBOUND = {
  active: {
    en: 'Chat commands: active (Gladys Plus).',
    fr: 'Commandes du chat : actives (Gladys Plus).',
  },
  no_plus: {
    en: 'Chat commands: off, they need Gladys Plus (only sending works).',
    fr: "Commandes du chat : inactives, elles demandent Gladys Plus (seul l'envoi marche).",
  },
  unknown: {
    en: 'Chat commands: Gladys Plus state unknown.',
    fr: 'Commandes du chat : état de Gladys Plus inconnu.',
  },
  no_token: {
    en: 'Chat commands: off, the token of the outgoing webhook is missing.',
    fr: 'Commandes du chat : inactives, le jeton du webhook sortant manque.',
  },
  token_invalid: {
    en: 'Chat commands: off, the token of the outgoing webhook cannot be read.',
    fr: 'Commandes du chat : inactives, le jeton du webhook sortant est illisible.',
  },
};

/** Why a message failed: `notSent`, `unconfirmed` (sent, no confirmation) or refused. */
const REASONS = {
  closed: { en: 'the integration is stopping', fr: "l'intégration s'arrête" },
  config_unread: {
    en: 'the configuration is not read yet',
    fr: "la configuration n'est pas encore lue",
  },
  config_changed: { en: 'the configuration changed', fr: 'la configuration a changé' },
  empty: { en: 'the message is empty', fr: 'le message est vide' },
  queue_full: {
    en: 'too many messages are waiting',
    fr: 'trop de messages sont en attente',
  },
  deadline: {
    en: 'the message waited too long in the queue',
    fr: "le message a trop attendu dans la file d'envoi",
  },
  certificate: {
    en: 'the certificate of the NAS is not confirmed',
    fr: "le certificat du NAS n'est pas confirmé",
  },
  certificate_typed: {
    en: 'the NAS shows another certificate than the fingerprint typed',
    fr: "le NAS présente un autre certificat que l'empreinte saisie",
  },
  tls: { en: 'the NAS refused the TLS connection', fr: 'le NAS a refusé la connexion TLS' },
  bad_answer: {
    en: 'the NAS did not answer in HTTP(S)',
    fr: "le NAS n'a pas répondu en HTTP(S)",
  },
  unreachable: { en: 'the NAS cannot be reached', fr: 'le NAS est injoignable' },
  timeout: { en: 'the NAS did not answer in time', fr: "le NAS n'a pas répondu à temps" },
  too_large: { en: 'the answer of the NAS is too large', fr: 'la réponse du NAS est trop grande' },
  unconfirmed: {
    en: 'the answer of the NAS cannot be read',
    fr: 'la réponse du NAS est illisible',
  },
};

export const T = {
  blocker: (code) => BLOCKERS[code] ?? BLOCKERS.url_invalid,
  inbound: (state) => INBOUND[state] ?? INBOUND.unknown,
  configUnread: {
    en: 'The configuration could not be read from Gladys yet: retrying.',
    fr: "La configuration n'a pas encore pu être lue depuis Gladys : nouvel essai.",
  },
  ready: (inbound) =>
    join(
      { en: 'Ready to send to Synology Chat.', fr: 'Prêt à envoyer vers Synology Chat.' },
      INBOUND[inbound] ?? INBOUND.unknown,
    ),
  certificate: (fingerprint) => ({
    en: `Certificate of the NAS not confirmed. Fingerprint shown by the NAS: ${fingerprint}. Check it in DSM (Control Panel > Security > Certificate), then copy it in "Certificate fingerprint". Nothing is sent until then.`,
    fr: `Certificat du NAS non confirmé. Empreinte présentée par le NAS : ${fingerprint}. Vérifiez-la dans DSM (Panneau de configuration > Sécurité > Certificat), puis copiez-la dans « Empreinte du certificat ». Rien n'est envoyé d'ici là.`,
  }),
  certificateTyped: (fingerprint) => ({
    en: `The NAS shows another certificate than the fingerprint typed: ${fingerprint}. If you renewed it, check it in DSM and type the new fingerprint. Nothing is sent until then.`,
    fr: `Le NAS présente un autre certificat que l'empreinte saisie : ${fingerprint}. Si vous l'avez renouvelé, vérifiez-le dans DSM et saisissez la nouvelle empreinte. Rien n'est envoyé d'ici là.`,
  }),
  paused: (minutes) => ({
    en: `The NAS asked to slow down (HTTP 429 or 5xx): no message sent for ${minutes} min.`,
    fr: `Le NAS a demandé de ralentir (HTTP 429 ou 5xx) : aucun message envoyé pendant ${minutes} min.`,
  }),
  reason: (code) => REASONS[code] ?? REASONS.unreachable,
  /** The outcome of one failed message. */
  failure: (f) => {
    if (f.kind === 'blocked') {
      return join(
        { en: 'Nothing sent:', fr: 'Rien envoyé :' },
        BLOCKERS[f.reason] ?? BLOCKERS.url_invalid,
      );
    }
    if (f.kind === 'paused') {
      return {
        en: `Nothing sent: the NAS asked to slow down, sending resumes in ${f.minutes} min.`,
        fr: `Rien envoyé : le NAS a demandé de ralentir, l'envoi reprend dans ${f.minutes} min.`,
      };
    }
    if (f.kind === 'pause_started') {
      return {
        en: `The NAS answered HTTP ${f.status}: message not posted, sending paused for ${f.minutes} min.`,
        fr: `Le NAS a répondu HTTP ${f.status} : message non publié, envoi suspendu pendant ${f.minutes} min.`,
      };
    }
    if (f.kind === 'refused') {
      const code = f.code === null ? '' : ` (code ${f.code})`;
      return {
        en: `Synology Chat refused the message${code}: check the incoming webhook is enabled and its URL up to date.`,
        fr: `Synology Chat a refusé le message${code} : vérifiez que le webhook entrant est actif et son URL à jour.`,
      };
    }
    if (f.kind === 'redirect') {
      return {
        en: `Nothing posted: the NAS answered a redirection (HTTP ${f.status}), never followed. Use the address and port of the URL shown by Synology Chat.`,
        fr: `Rien publié : le NAS a répondu une redirection (HTTP ${f.status}), jamais suivie. Utilisez l'adresse et le port de l'URL affichée par Synology Chat.`,
      };
    }
    if (f.kind === 'http') {
      return {
        en: `The NAS answered HTTP ${f.status}: message not posted.`,
        fr: `Le NAS a répondu HTTP ${f.status} : message non publié.`,
      };
    }
    const reason = REASONS[f.reason] ?? REASONS.unreachable;
    if (f.kind === 'unconfirmed') {
      return {
        en: `Message sent, without confirmation: ${reason.en}. Check the channel before sending it again.`,
        fr: `Message envoyé, sans confirmation : ${reason.fr}. Vérifiez le canal avant de le renvoyer.`,
      };
    }
    return { en: `Nothing sent: ${reason.en}.`, fr: `Rien envoyé : ${reason.fr}.` };
  },
  testSent: {
    en: 'Test message posted in Synology Chat.',
    fr: 'Message de test publié dans Synology Chat.',
  },
  testText: 'Gladys: test message / message de test',
  join,
};
