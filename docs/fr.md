# Remootio pour Gladys Assistant

Intégration non officielle, sans lien avec Remootio. **Jamais testé avec un vrai appareil** : elle suit la
documentation officielle de l'API Websocket de Remootio et a été vérifiée contre un faux Remootio qui en
reproduit les trames et leur cryptographie. Vos retours avec un vrai Remootio sont les bienvenus.

## Ce que fait l'intégration

Pour chaque Remootio (deux au plus), par son API Websocket locale (sans le cloud Remootio) :

- l'**état** du portail ou de la porte de garage (fermé ou non fermé), si un capteur d'état est installé ;
- deux **boutons** : **Ouvrir** et **Fermer** (jamais un interrupteur : un « tout éteindre » ou une scène sur
  des interrupteurs n'atteint pas le portail).

L'état arrive dès qu'il change (événements poussés par le Remootio) et il est relu toutes les 5 minutes.

## Mise en place

1. Dans l'application Remootio, avec la clé maître : **Device software**, puis **Remootio Websocket API**.
   Activez l'API, de préférence **avec journalisation** (« Enable API with logging ») : Gladys voit alors aussi
   les impulsions des autres **clés Remootio** (application, clés partagées, automatisations Remootio) et du
   bouton manuel du Remootio, et attend la fin de la course avant d'en envoyer une.
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
- **Ouvrir ET Fermer sont désactivés par défaut** ; cochez « Autoriser l'ouverture et la fermeture » pour les
  utiliser (décision du 2026-10-25, la même que pour OpenGarage et ismartgate), car **Fermer peut ouvrir ou
  arrêter la porte** dans ces cas :
  - **une porte en train de se fermer sans que le Remootio le sache** : télécommande d'origine du moteur,
    bouton mural, fermeture automatique du moteur, clé Remootio quand l'API est sans journalisation, ou
    durée de course réglée trop courte. Le capteur lit « ouverte » jusqu'en bas, l'impulsion arrête la porte
    ou la fait remonter ;
  - **un capteur qui lit « ouverte » sur une porte fermée** (fil coupé, aimant décollé, logique inversée) :
    Fermer devient une impulsion à l'aveugle et ouvre la porte. Vérifiez l'état affiché dans l'application
    Remootio avant d'automatiser une fermeture.
- Après une impulsion (de Gladys, d'une autre clé Remootio ou du bouton manuel si l'API est activée avec
  journalisation, ou une sortie déjà en train d'être actionnée), la suivante attend la **durée de course**
  configurée (30 s par défaut) plus 5 s. Après une fermeture, elle attend seulement jusqu'à ce que la porte
  soit lue fermée. Cette garde est enregistrée dans `/data` avant l'envoi : un redémarrage la garde. Les
  impulsions de la télécommande d'origine et du bouton mural du moteur ne passent pas par le Remootio : aucune
  garde ne les suit.

### Les cas où une commande est refusée

Ouvrir ou Fermer est refusé, sans rien envoyer, dans ces cas :

- la configuration n'est pas encore chargée (elle est redemandée à Gladys) ;
- l'option « Autoriser l'ouverture et la fermeture » n'est pas cochée ;
- l'adresse ou une clé de ce Remootio manque ou est invalide, ou ce Remootio n'est plus dans la configuration,
  ou un autre Remootio répond à son adresse ;
- les clés ont été refusées par le Remootio (voir plus bas) ;
- une impulsion est partie il y a moins que la durée de course plus 5 s, ou la porte vient d'être actionnée
  par une autre clé Remootio ou par le bouton manuel ;
- une autre commande de la même porte est en cours (une fermeture annule une ouverture pas encore envoyée) ;
- le Remootio n'a pas pu être joint dans les 3,5 s ;
- la garde de l'impulsion n'a pas pu être écrite dans `/data` ;
- la configuration a changé pendant la commande.

Le Remootio lui-même peut ensuite refuser l'action : pas de capteur d'état (ERR_NO_SENSOR) ; sortie en train
d'être actionnée (ERR_RELAY_BUSY : la porte va bouger, Gladys pose la garde de course et ne renvoie rien) ;
déjà dans l'état demandé (rien ne bouge, la commande est réussie).

### La fermeture gardée

Une fermeture qui n'a pas pu partir dans les 3,5 s (Remootio injoignable) est **gardée** : elle part à la
prochaine connexion, essayée toutes les 5 s, **jusqu'à 2 minutes après le clic**, 3 essais au plus. La porte
peut donc bouger jusqu'à 2 minutes après le clic, sans personne pour regarder : seules les sécurités du moteur
(cellules, détection d'effort) protègent alors quelqu'un sous la porte. Elle est abandonnée, et le statut le
dit, si :

- le Remootio n'a pas pu être joint en 2 minutes, ou 3 essais n'ont pas abouti ;
- l'historique que le Remootio renvoie à la reconnexion montre que la porte a bougé pendant la coupure ;
- une autre clé Remootio ou le bouton manuel a actionné la porte, ou la sortie était en train d'être
  actionnée ;
- l'option « Autoriser l'ouverture et la fermeture » a été décochée.

Une ouverture partie entre-temps l'annule sans message.

### Après l'envoi

Si l'action a pu partir sans que la réponse arrive, Gladys répond « Commande envoyée, sans confirmation »,
garde la garde, et ouvre une nouvelle connexion. Avant d'écrire une impulsion, la connexion est vérifiée par
un PING si rien n'a été reçu depuis 2 s. L'état est relu 5 s et 15 s après une impulsion, puis à la fin de la
course ; une porte qui n'est pas lue là où elle a été envoyée (obstacle, télécommande, course plus longue que
configurée), ou un état qui n'a pas pu être relu, est signalé dans le statut.

## Connexion et clés refusées

- La connexion est ouverte au démarrage et gardée ; une connexion perdue est rouverte après 5 s, 15 s, 30 s,
  1 min, 2 min, puis toutes les 5 minutes (toutes les 5 s tant qu'une fermeture est gardée). Un PING part
  chaque minute.
- Une commande n'attend pas la reconnexion : elle utilise la connexion ouverte, sinon en ouvre une nouvelle
  tout de suite, après avoir fermé l'ancienne ; ses essais n'allongent pas l'attente de la reconnexion.
- **Clés refusées** : deux fois de suite, le Remootio a répondu par un défi que ces clés n'ouvrent pas. Plus
  aucun essai automatique, le statut le dit. Une connexion lente, coupée ou prise par une autre domotique
  pendant l'authentification n'est pas un refus. Enregistrez les bonnes clés ou une autre adresse, ou utilisez
  le bouton **Vérifier les Remootio** (un essai, au plus toutes les 30 s ; le refus n'est levé que par un
  succès).
- **Un autre Remootio répond à l'adresse** (son numéro de série n'est pas celui attendu, et les clés ne
  l'ouvrent pas) : le statut le dit, les essais continuent normalement ; corrigez l'adresse.

## Limites connues

- Sans capteur d'état, rien n'est lu et les deux boutons sont refusés par le Remootio.
- Sans journalisation dans l'API, les impulsions des autres clés Remootio ne sont pas vues ; la télécommande
  d'origine et le bouton mural du moteur ne le sont dans aucun cas.
- Pendant la toute première fraction de seconde d'une ouverture lancée par la télécommande, le capteur lit
  encore « fermé » : une ouverture envoyée à ce moment arrêterait la porte.
- Le protocole n'a pas de valeur aléatoire du client : quelqu'un qui enregistre le réseau local peut rejouer
  une session entière ; ce n'est pas corrigeable côté Gladys.
- La sortie secondaire (« free relay output » du Remootio 2) n'est pas utilisée.
