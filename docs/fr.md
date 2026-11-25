# Synology Chat pour Gladys Assistant

Intégration externe non officielle, sans lien avec Synology. Elle fait deux choses :

- **Gladys → chat** : vos scènes publient un message dans un canal de Synology Chat, par un _webhook entrant_
  du NAS ;
- **chat → Gladys** : un message tapé dans Synology Chat (mot déclencheur d'un _webhook sortant_, commande slash
  ou message à un bot) lance une scène Gladys. Ce sens passe par les webhooks de **Gladys Plus** : sans Gladys
  Plus, seul l'envoi marche, et le statut de l'intégration le dit.

Écrite d'après l'aide officielle Synology « Using Integration in Synology Chat ». Elle n'a **jamais été testée
avec un vrai NAS** : seulement contre un faux serveur qui suit cette aide. Vos retours sont les bienvenus.

## 1. Envoyer des messages depuis les scènes

1. Dans Synology Chat, cliquez sur votre photo de profil > **Intégration** > **Webhooks entrants** > **Créer**,
   choisissez le canal, puis copiez l'**URL du webhook**. Elle ressemble à
   `https://nas:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22…%22`.
2. Dans Gladys, page de l'intégration, collez-la dans **URL du webhook entrant**. Cette URL permet à quiconque
   la connaît de publier dans le canal : elle est gardée par Gladys dans sa base, jamais réaffichée, envoyée
   seulement à votre NAS, et l'intégration ne l'écrit dans aucun journal ni statut.
3. Cliquez sur **Envoyer un message de test**.
4. Dans une scène, ajoutez l'action **Envoyer un message Synology Chat** et écrivez le texte ; les variables de
   scène (`{{…}}`) sont permises.

Règles d'envoi :

- 2000 caractères au plus (au-delà, le texte est coupé et finit par « … ») ; les caractères de contrôle sont
  retirés ; les liens suivent la syntaxe de Synology Chat (`<https://exemple.fr|cliquez ici>`).
- Un message à la fois, au moins une seconde entre deux ; 10 messages au plus en attente. Un message qui n'a pas
  pu partir dans les 15 secondes est abandonné (« Rien envoyé »).
- Si le NAS répond HTTP 429 ou 5xx, plus aucun message n'est envoyé pendant 1 minute, puis 2, 4… jusqu'à 1 heure
  si cela se répète (plus longtemps si le NAS le demande par `Retry-After`, 6 heures au plus). Cette pause est
  gardée dans `/data` et survit à un redémarrage ; le bouton de test l'attend aussi. Un message accepté la remet à
  zéro, et une nouvelle URL ou une nouvelle empreinte la lève (elle concernait l'ancienne cible). Après un 5xx, la
  publication n'est pas confirmée : un proxy (502, 504) peut répondre ainsi après que le message a été publié.
- L'intégration n'envoie jamais un message deux fois. Si le NAS ne répond pas après avoir reçu la requête,
  l'action de scène échoue avec « Message envoyé, sans confirmation » : regardez le canal avant de renvoyer.
- Une redirection du NAS n'est jamais suivie (l'URL porte le jeton) : utilisez l'adresse et le port que Synology
  Chat affiche.

### Certificat du NAS

L'URL commence normalement par `https://`. Avant d'écrire le moindre octet (le chemin de la requête contient le
jeton), l'intégration vérifie le certificat présenté par le NAS :

- **certificat signé par une autorité** (un certificat gratuit obtenu par DSM pour votre nom de domaine) et valable pour le nom de l'URL :
  rien à faire, laissez **Empreinte du certificat** vide ;
- **certificat auto-signé** (le cas par défaut d'un NAS joint par son adresse IP) : le premier essai échoue avec
  « Rien envoyé », et le statut affiche l'**empreinte SHA-256** présentée par le NAS. Vérifiez-la dans DSM
  (**Panneau de configuration > Sécurité > Certificat**, détails du certificat), puis copiez-la dans
  **Empreinte du certificat**. Dès lors, seul ce certificat est accepté.

Une empreinte saisie est la seule référence : si le NAS présente un autre certificat (renouvelé, ou autre
machine), rien n'est envoyé et le statut affiche la nouvelle empreinte, à vérifier puis à saisir. L'intégration
n'apprend jamais un certificat d'elle-même.

**Autoriser HTTP** (désactivé par défaut) accepte une URL en `http://` (port 5000) : le jeton et les messages
passent alors en clair sur votre réseau.

## 2. Lancer une scène depuis le chat (Gladys Plus)

1. Liez Gladys Plus à votre Gladys et collez votre clé Open API dans le bloc **Webhooks Gladys Plus** de la page
   de l'intégration : Gladys affiche une URL publique pour le webhook « Webhook sortant de Synology Chat ».
2. Dans Synology Chat > **Intégration**, créez un **webhook sortant** (un canal et/ou des mots déclencheurs),
   une **commande slash** ou un **bot**, avec cette URL comme adresse sortante.
3. Copiez le **jeton** que Synology Chat affiche pour ce webhook (ou cette commande, ou ce bot) dans
   **Jeton(s) du webhook sortant** (jusqu'à 5, séparés par des espaces). Il est gardé par Gladys dans sa base,
   jamais réaffiché, jamais envoyé nulle part par l'intégration. Les messages tapés dans le chat (et ce jeton,
   qui les accompagne) passent par la passerelle Gladys Plus avant d'arriver à votre Gladys.
4. Dans une scène, choisissez le déclencheur **Commande Synology Chat reçue**.

Le déclencheur peut filtrer sur la **commande** (le message sans le mot déclencheur, espaces regroupés), le
**mot déclencheur**, le **nom d'utilisateur** et le **canal**. Les filtres sont exacts, casse comprise : avec le
mot déclencheur `gladys`, le message `gladys lumières off` donne la commande `lumières off`. Variables
disponibles : message entier, commande, mot déclencheur, nom et identifiant de l'utilisateur, canal et son
identifiant, source (`channel` pour un webhook sortant de canal, `direct` pour une commande slash ou un bot).

Sécurité et limites :

- Une requête dont le champ `token` du formulaire n'est pas l'un des jetons saisis est ignorée ; sans jeton
  saisi, **toutes** sont ignorées. Le jeton n'est jamais lu dans l'URL.
- Gladys ne répond **jamais** d'elle-même dans le chat : le webhook répond vide, et rien n'est envoyé en réaction
  à un message reçu. Si une scène lancée par une commande envoie un message qui commence par le mot déclencheur,
  ce message, s'il revient dans la minute par le webhook sortant **avec exactement le même texte**, est reconnu
  et ignoré. Si Synology Chat modifiait le texte (liens, caractères spéciaux), seule la limite de 20 requêtes par
  minute freinerait la boucle : choisissez un mot déclencheur que les réponses de vos scènes ne reprennent pas.
- 20 requêtes par minute au plus ; un même message (`post_id`) n'est traité qu'une fois tant que l'intégration
  tourne ; un message daté de plus de 10 minutes d'écart avec l'horloge de Gladys est ignoré.
- Les messages à boutons des bots (actions interactives) ne sont pas lus.

## Statut

La page de l'intégration indique : prêt à envoyer, ou ce qui bloque (URL absente ou illisible, `http://` sans
l'option, empreinte invalide, certificat à confirmer avec son empreinte, pause du NAS, dernier échec), puis
l'état des commandes du chat (actives, sans Gladys Plus, jeton manquant ou illisible). Le dernier échec
s'efface au premier message accepté, ou quand l'URL, l'empreinte ou l'option HTTP changent.

## Données gardées

`/data/synology-chat-state.json` garde seulement la fin de la pause demandée par le NAS et son niveau. Jamais
l'URL, un jeton ni un message. Un fichier illisible n'est jamais écrasé.
