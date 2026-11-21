# Westaf Records — API de gestion du studio

API Node.js (Express, ESM) + MySQL qui alimente le site `DakarVibeStudio` : comptes clients, réservations
avec disponibilités en temps réel, paiements PayTech (acompte, solde, espèces), notifications WhatsApp
(Cloud API de Meta), rôles (super admin, admin/Jeuss, ingénieur du son, client), services, équipements et galerie.

## Démarrage rapide

```bash
npm install
cp .env.example .env      # puis compléter (voir ci-dessous)
npm run migrate           # facultatif : les migrations s'appliquent aussi au démarrage
npm start                 # ou npm run dev
```

Node.js 18 ou plus récent, MySQL 8 (ou MariaDB 10.5+).

### Variables

**Aucune variable n'est à ajouter au `.env` déjà en place sur Hostinger.** La nouvelle version lit les
variables de l'ancienne (`DB_*`, `PAYTECH_*`, `FRONTEND_URL`, `CORS_ORIGINS`, `ADMIN_TOKEN_SECRET`…) et :

- génère elle-même la clé des sessions et les clés des notifications push au premier démarrage
  (table `app_secrets`) si `JWT_SECRET` / `VAPID_*` sont absents ;
- utilise par défaut `https://westafrecords.com` et l'URL Hostinger de l'API ;
- crée le super admin et l'admin (Jeuss) par la migration `012_staff_accounts`.

Les variables ci-dessous restent possibles mais facultatives :

| Variable | Rôle |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Base MySQL (Hostinger) |
| `JWT_SECRET` | Signature des sessions, 32 caractères minimum (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `FRONTEND_URL` | URL du site (liens WhatsApp / e-mail, retours PayTech) |
| `PUBLIC_API_URL` | URL publique de l'API (sert à construire l'IPN PayTech) |
| `CORS_ORIGINS` | Origines autorisées, séparées par des virgules |

### Comptes initiaux

Le super admin et l'admin (Jeuss) sont créés par la migration `012_staff_accounts` (empreinte du mot de
passe uniquement ; changement obligatoire à la première connexion). Facultatif, si aucun compte de ce rôle n'existe :

- `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` → super administrateur ;
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` (+ `ADMIN_FIRST_NAME=Jeuss`) → administrateur (Jeuss).

Les deux comptes doivent changer leur mot de passe à la première connexion sur `/admin`.
Vous pouvez aussi utiliser :

```bash
npm run create-user -- --role super_admin --email moi@exemple.com --first "Prénom" --last "Nom"
```

(sans `--password`, un mot de passe provisoire est généré et affiché une fois).
Les ingénieurs du son sont ensuite créés par Jeuss depuis **Administration → Ingénieurs son**.

> Les anciennes variables `ADMIN_LOGIN` / `ADMIN_TOKEN_SECRET` ne sont plus utilisées pour la connexion.
> `ADMIN_TOKEN_SECRET` sert uniquement de secours si `JWT_SECRET` est absent.

## Base de données et migrations

Les migrations (`migrations/`) sont suivies dans la table `schema_migrations` et ne s'appliquent qu'une fois.
**Aucune donnée n'est supprimée.**

| Migration | Contenu |
|---|---|
| `001_base_tables` | Tables historiques (`reservations`, `clients`, `credential_reveals`) si absentes |
| `002_platform_schema` | `users`, `password_resets`, `settings`, `services`, `opening_hours`, `closures`, `engineer_unavailability`, `slot_locks`, `payments`, `reservation_history`, `notifications`, `whatsapp_messages`, `equipment`, `equipment_photos`, `gallery_photos` ; nouvelles colonnes sur `reservations` (les colonnes existantes sont conservées) |
| `003_backfill_and_seed` | Reprise des données : chaque compte `clients` devient un `users` (même mot de passe, connexion par téléphone ou par l'e-mail retrouvé dans ses réservations) ; chaque e-mail de réservation sans compte devient un compte client sans mot de passe (récupérable via « Mot de passe oublié » ou Google) ; rattachement des réservations, calcul des créneaux, statuts de paiement, historique des paiements. Insère la configuration réelle : services et tarifs du site, horaires (lun.–sam. 08h–00h), équipements listés sur le site, numéro WhatsApp de Jeuss (+221 77 860 04 82) |

| `004_invoices` | Tables `invoices` et `invoice_counters`, mentions légales par défaut ; factures émises rétroactivement pour les réservations déjà payées |

`schema.sql` est conservé pour référence ; il n'est plus nécessaire de l'importer à la main.

Sauvegardez la base avant la première mise en production de cette version (phpMyAdmin → Exporter).

## Rôles et permissions (appliqués côté serveur)

| | Client | Ingénieur | Admin (Jeuss) | Super admin |
|---|---|---|---|---|
| Ses réservations, report, paiement | ✔ | | | |
| Ses sessions attribuées, statut opérationnel, notes, absences | | ✔ | | |
| Toutes les réservations, clients, services, équipements, galerie, horaires, paramètres, finances | | | ✔ | ✔ |
| Créer / gérer les ingénieurs | | | ✔ | ✔ |
| Créer / gérer les administrateurs | | | | ✔ |

- `/engineer/*` renvoie uniquement une liste blanche de champs : aucun montant, tarif, statut de paiement,
  encaissement ou statistique financière. Les routes `/admin/*` renvoient 403 aux ingénieurs.
- Une désactivation, un changement de rôle ou de mot de passe révoque immédiatement les sessions ouvertes.
- Un compte lié à des réservations ne peut pas être supprimé (il est désactivé) ; il reste toujours au moins un super admin actif.

## Réservations et disponibilités

- Créneaux à l'heure, calculés à partir des horaires (`opening_hours`), pauses, fermetures (`closures`),
  réservations existantes, absences des ingénieurs (option), délai minimum et fenêtre de réservation.
- **Double réservation impossible** : chaque heure occupée est une ligne de `slot_locks` (clé primaire),
  y compris en cas de requêtes simultanées. Le créneau est bloqué pendant le paiement (`hold_minutes`, 30 min),
  puis libéré automatiquement si le paiement n'aboutit pas.
- **Report client** : possible jusqu'à `reschedule_limit_minutes` (120) avant la session, vers un créneau libre ;
  l'ancien créneau est libéré dans la même transaction. Jeuss, l'ingénieur et le client sont notifiés.

## Paiement

1. À la réservation : acompte (50 %, service « Enregistrement studio ») ou total, via PayTech.
   L'IPN (`POST /ipn`, HMAC vérifié) confirme la réservation.
2. 10 min avant la session (`payment_link_minutes_before`) : message WhatsApp avec le lien
   `FRONTEND_URL/paiement/<jeton>` (montant restant) et un bouton « Payer en espèces ».
3. Paiement en ligne confirmé **ou** espèces validées par Jeuss → paiement « Payé » et session
   « Autorisée à commencer ». Le démarrage d'une session non autorisée est refusé par l'API.

Les paiements lancés par l'ancienne version du site (données dans `custom_field`) sont encore acceptés par l'IPN.

## Factures

Une facture par réservation, émise automatiquement au premier encaissement (acompte, solde en ligne, espèces
validées ou paiement de l'ancien site), numérotée sans trou par année : `WR-2026-0001`. Elle affiche les lignes,
les règlements reçus et le reste à payer. Le client voit uniquement ses factures (`/client/invoices`),
l'administration toutes (`/admin/invoices`) ; les ingénieurs n'y ont pas accès. Raison sociale, adresse, NINEA,
RCCM, préfixe et mention de bas de page : **Paramètres → Facturation**.

Téléchargement PDF (généré par le serveur avec pdfkit) : `GET /client/invoices/:id/pdf` (le client, pour ses
factures uniquement) et `GET /admin/invoices/:id/pdf` (Jeuss et super admin). Logo : `assets/invoice-logo.jpg`.

## WhatsApp Cloud API

Aucun message n'est simulé. Sans configuration, chaque envoi est journalisé avec le statut `not_configured`
(visible dans **Paramètres → WhatsApp**) et une notification d'échec apparaît dans le tableau de bord.

### 1. Compte Meta

1. Créez une application sur <https://developers.facebook.com> (type *Business*), ajoutez le produit **WhatsApp**.
2. Associez un numéro WhatsApp Business ; notez le **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. Créez un utilisateur système avec un **jeton permanent** (permissions `whatsapp_business_messaging`,
   `whatsapp_business_management`) → `WHATSAPP_TOKEN`.
4. **Paramètres de l'app → Général → Clé secrète** → `WHATSAPP_APP_SECRET`.
5. Webhook : URL `https://<votre-api>/webhooks/whatsapp`, jeton de vérification = `WHATSAPP_VERIFY_TOKEN`
   (valeur de votre choix), abonnez le champ **messages**.

### 2. Modèles de messages (langue : Français `fr`, catégorie *Utility*)

Les noms peuvent être changés via `WA_TPL_*`. Le texte peut être ajusté, mais **le nombre de variables
et l'ordre des boutons doivent rester identiques**.

**`studio_alerte_admin`** — notifications à Jeuss et aux ingénieurs (2 variables)
```
🔔 {{1}}

{{2}}
```

**`studio_info_client`** — confirmations, reports, annulations (2 variables)
```
Bonjour {{1}},

{{2}}
```

**`studio_rappel_session`** — rappel 2 h avant (3 variables, 2 boutons « Réponse rapide »)
```
Bonjour {{1}}, nous vous rappelons que votre session au {{2}} est prévue aujourd'hui à {{3}}.

Merci de nous confirmer votre présence.

Êtes-vous toujours disponible pour cette session ?
```
Boutons : 1. réponse rapide « Confirmer ma présence » · 2. réponse rapide « Je souhaite reporter ma session »

**`studio_lien_paiement`** — 10 min avant (3 variables, 2 boutons)
```
Bonjour {{1}}, votre session commence dans quelques minutes.

Montant restant à régler : {{2}}.

Réglez en ligne avec le lien ci-dessous, ou choisissez le paiement en espèces sur place. À tout de suite chez {{3}} !
```
Boutons : 1. **URL dynamique** « Payer maintenant » → `https://westafrecords.com/paiement/{{1}}` ·
2. réponse rapide « Payer en espèces »

Les réponses (boutons) arrivent sur le webhook : présence confirmée, demande de report (le client reçoit
le lien pour choisir un nouveau créneau) ou paiement en espèces (Jeuss est prévenu). Les événements rejoués
par Meta sont ignorés (déduplication par identifiant de message).

## Autres intégrations

- **Google** : console Google Cloud → Identifiants → *ID client OAuth* « Application Web » ; ajoutez
  l'URL du site dans *Origines JavaScript autorisées* → `GOOGLE_CLIENT_ID`. Le jeton est vérifié par l'API.
- **E-mails** (mot de passe oublié, confirmations) : SMTP Hostinger (`smtp.hostinger.com`, port 465)
  avec une boîte e-mail du domaine → `SMTP_*`, `MAIL_FROM`.
- **PayTech** : `PAYTECH_API_KEY`, `PAYTECH_API_SECRET`, `PAYTECH_IPN_URL=https://<api>/ipn`.
  ⚠️ L'ancien `.env.example` contenait de vraies clés PayTech dans l'historique Git : régénérez-les depuis
  votre espace PayTech.

## Notifications push (téléphones)

Chaque notification de l'équipe (nouvelle réservation, paiement, demande d'espèces, report…) et du client
est aussi envoyée en notification push sur les appareils où la personne l'a autorisée.

Les clés sont générées automatiquement au premier démarrage et conservées en base (table `app_secrets`) :
aucune variable à ajouter. Paramètres → Intégrations affiche « Notifications push » en vert.

Les abonnements sont stockés dans `push_subscriptions` (migration 010) et supprimés automatiquement quand
le navigateur les invalide. Le site doit être servi en **HTTPS**. Sur iPhone (iOS 16.4+), l'application doit
d'abord être ajoutée à l'écran d'accueil.

## Tâches planifiées

Le planificateur interne tourne toutes les minutes (rappels, liens de paiement, libération des créneaux non
payés), protégé par un verrou MySQL (une seule instance l'exécute). Si l'hébergeur met l'application en veille,
mettez `SCHEDULER_ENABLED=false` et appelez chaque minute :

```bash
curl -X POST https://<api>/cron/tick -H "X-Cron-Secret: $CRON_SECRET"
```

## Images

Les photos importées sont stockées dans `UPLOAD_DIR` (`uploads/` par défaut) et servies sur `/uploads/…`.
Ce dossier doit être **persistant** et inclus dans vos sauvegardes (8 Mo max par image, JPEG/PNG/WebP/AVIF,
signature binaire vérifiée).

## Déploiement (Hostinger, application Node.js)

1. Envoyez le dépôt (Git ou gestionnaire de fichiers), point d'entrée `server.js`.
2. Créez le fichier `.env` sur le serveur (jamais dans Git).
3. `npm install --omit=dev`, puis démarrez l'application : les migrations s'appliquent au démarrage.
4. Vérifiez `GET /health` (état de la base et des intégrations).
5. Configurez PayTech (IPN), le webhook Meta et, si besoin, la tâche cron.

## Tests

Tests d'intégration de bout en bout sur un vrai MySQL éphémère (PayTech et Meta y sont remplacés par un
serveur local qui enregistre les requêtes, **uniquement dans les tests**) :

```bash
node test/start-db.mjs &     # télécharge et lance MySQL 8.4 (première fois : quelques minutes)
npm test
```

Option : `DB_JSON=./.db-tests.json` (sur les deux commandes) utilise un autre fichier de connexion,
pour lancer les tests sur une base séparée.

Couvre : comptes historiques, inscription, mot de passe oublié, rôles et refus d'accès, finances invisibles
pour l'ingénieur, disponibilités, réservation + IPN, concurrence sur un même créneau, report et limite des 2 h,
espèces → « Payé » → « Autorisée à commencer », solde en ligne, rappel et lien de paiement sans doublon,
webhook signé, numéro WhatsApp modifiable, services / équipements / galerie, désactivation de compte.


## Principales routes

| Préfixe | Accès | Exemples |
|---|---|---|
| `/auth` | public / connecté | `register`, `login`, `google`, `forgot-password`, `reset-password`, `me`, `change-password` |
| `/public` | public | `config`, `services`, `equipment`, `gallery`, `availability/days`, `availability/slots` |
| `/client` | client | `reservations` (liste, création), `/:id/reschedule`, `/:id/pay-balance`, `/:id/pay-cash` |
| `/actions/:jeton` | lien WhatsApp | résumé, `presence`, `pay-online`, `pay-cash` |
| `/admin` | admin, super admin | `dashboard`, `reservations`, `calendar`, `payments`, `clients`, `users`, `services`, `equipment`, `gallery`, `settings`, `hours`, `closures`, `whatsapp` |
| `/engineer` | ingénieur | `overview`, `sessions`, `sessions/:id/status`, `unavailability` |
| `/ipn`, `/webhooks/whatsapp`, `/cron/tick` | fournisseurs | signatures vérifiées |
