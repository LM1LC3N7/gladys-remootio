# Remootio pour Gladys Assistant

Intégration non officielle, sans lien avec Remootio. **Jamais testé avec un vrai appareil** : elle suit la
documentation officielle de l'API Websocket de Remootio et a été vérifiée contre un faux Remootio qui en
reproduit les trames et leur cryptographie. Vos retours avec un vrai Remootio sont les bienvenus.

## Ce que fait l'intégration

Pour chaque Remootio (deux au plus), par son API Websocket locale (sans le cloud Remootio) :

- l'**état** du portail ou de la porte de garage (fermé ou non fermé), si un capteur d'état est installé ;
- deux **boutons** : **Ouvrir** et **Fermer** (jamais un interrupteur : un « tout éteindre » ou une scène sur
  des interrupteurs n'atteint jamais le portail).

L'état arrive dès qu'il change (événements poussés par le Remootio) et il est relu toutes les 5 minutes.

## Mise en place

1. Dans l'application Remootio, avec la clé maître : **Device software**, puis **Remootio Websocket API**.
   Activez l'API, de préférence **avec journalisation** (« Enable API with logging ») : Gladys voit alors aussi
   les impulsions des autres clés (télécommande, application, automatisations) et attend la fin de la course
   avant d'en envoyer une.
2. L'application affiche l'**API Secret Key**, l'**API Auth Key** (64 chiffres hexadécimaux chacune) et
   l'adresse IP. Donnez au Remootio une adresse IP fixe dans votre box.
3. Dans Gladys, configuration de l'intégration : saisissez l'adresse et les deux clés. Les champs de clé sont
   gardés par Gladys dans sa base, jamais réaffichés, et servent seulement avec ce Remootio, sur votre réseau
   local. Les clés n'apparaissent dans aucun journal, aucun statut, aucun fichier de `/data`.
4. Ajoutez l'appareil depuis l'onglet **Découverte**.

Logiciel du Remootio : 2.21 ou plus récent (API v2 ou v3). Une version plus ancienne ne donne pas son numéro
de série : le statut le dit, mettez le Remootio à jour.

L'API n'accepte qu'**une connexion à la fois** : si une autre domotique (Home Assistant…) est connectée au même
Remootio, les deux se coupent l'une l'autre.

## Ouvrir et fermer

La sortie du Remootio commande le moteur par une **impulsion qui est une bascule** : la même impulsion ouvre
une porte fermée, ferme une porte ouverte, et arrête ou inverse une porte en mouvement. Pour cette raison :

- Gladys n'envoie que les actions **OPEN** et **CLOSE** de l'API, jamais l'impulsion simple (TRIGGER) : le
  Remootio n'actionne sa sortie que si **son propre capteur** lit la porte fermée (Ouvrir) ou ouverte
  (Fermer), au moment où l'action arrive. Sans capteur d'état, il refuse les deux.
- Pour le capteur, « ouverte » veut aussi dire « en mouvement » : fermer peut donc arrêter ou inverser une
  porte qui bouge. **Ouvrir ET Fermer sont désactivés par défaut** ; cochez « Autoriser l'ouverture et la
  fermeture » pour les utiliser (décision du 2026-10-25, la même que pour OpenGarage et ismartgate).
- Après une impulsion (de Gladys, ou d'une autre clé si l'API est activée avec journalisation), la suivante
  attend la **durée de course** configurée (30 s par défaut) plus 5 s. Après une fermeture, elle attend
  seulement jusqu'à ce que la porte soit lue fermée. Cette garde est enregistrée dans `/data` avant l'envoi :
  un redémarrage la garde.

### Les cas où une commande est refusée

Ouvrir ou Fermer est refusé, sans rien envoyer, dans ces cas :

- l'option « Autoriser l'ouverture et la fermeture » n'est pas cochée ;
- l'adresse ou une clé de ce Remootio manque ou est invalide, ou ce Remootio n'est plus dans la configuration
  (ou un autre Remootio répond avec ses clés) ;
- les clés ont été refusées par le Remootio (voir plus bas) ;
- une impulsion est partie il y a moins que la durée de course plus 5 s, ou la porte vient d'être actionnée
  par une autre clé ;
- une autre commande de la même porte est en cours (une fermeture annule une ouverture pas encore envoyée) ;
- le Remootio n'a pas pu être joint dans les 3,5 s (une fermeture est alors **gardée** et envoyée à la
  prochaine connexion, dans les 2 minutes, 3 essais au plus, sauf si une autre commande est partie ou si une
  autre clé a actionné la porte entre-temps) ;
- la garde de l'impulsion n'a pas pu être écrite dans `/data` ;
- la configuration a changé pendant la commande.

Le Remootio lui-même peut ensuite refuser l'action : pas de capteur d'état (ERR_NO_SENSOR), sortie occupée
(ERR_RELAY_BUSY : une fermeture est alors renvoyée quelques secondes plus tard), ou déjà dans l'état demandé
(rien ne bouge, la commande est réussie).

Si l'action a pu partir sans que la réponse arrive, Gladys répond « Commande envoyée, sans confirmation » et
garde la garde. L'état est relu 5 s et 15 s après une impulsion, puis à la fin de la course ; une porte qui
n'est pas lue là où elle a été envoyée (obstacle, télécommande, course plus longue que configurée) est
signalée dans le statut.

## Connexion et clés refusées

- La connexion est ouverte au démarrage et gardée ; une connexion perdue est rouverte après 5 s, 15 s, 30 s,
  1 min, 2 min, puis toutes les 5 minutes. Un PING part quand rien n'est reçu pendant une minute.
- Une commande n'attend pas la reconnexion : elle utilise la connexion ouverte (vérifiée par un PING si elle
  est silencieuse depuis 10 s), sinon en ouvre une nouvelle tout de suite, après avoir fermé l'ancienne.
- **Clés refusées** deux fois de suite (le Remootio ne reconnaît pas les clés, ou ferme la connexion pendant
  l'authentification) : plus aucun essai automatique, le statut le dit. Enregistrez d'autres clés, ou utilisez
  le bouton **Vérifier les Remootio** (un essai, au plus toutes les 30 s ; le refus n'est levé que par un
  succès).

## Limites connues

- Sans capteur d'état, rien n'est lu et les deux boutons sont refusés par le Remootio.
- Sans journalisation dans l'API, les impulsions des autres clés ne sont pas vues : seule la garde des
  impulsions de Gladys s'applique.
- Pendant la toute première fraction de seconde d'une ouverture lancée par la télécommande, le capteur lit
  encore « fermé » : une ouverture envoyée à ce moment arrêterait la porte.
- La sortie secondaire (« free relay output » du Remootio 2) n'est pas utilisée.
