# Pear Mobile

Deux applis mobiles, complémentaires :

| | `android/` — **Pear (APK)** | `remote/` — **Pear Remote (PWA)** |
|---|---|---|
| Rôle | Lecteur YouTube Music autonome sur le téléphone | Télécommande de Pear Desktop sur le PC |
| Son | sort du téléphone | sort du PC |
| Besoin | rien (compte Google optionnel) | Pear Desktop lancé, plugin **API Server** actif |

## 1. APK Android (`android/`)

WebView sur `music.youtube.com`, avec le portage mobile de plugins de Pear Desktop :

- **Lecture en arrière-plan** : écran éteint ou appli en fond, avec notification média
  (contrôles écran de verrouillage, casque/Bluetooth).
- **Bloqueur de pubs** : nettoyage des réponses du lecteur (comme `do-not-track/injectors/inject.ts`)
  et blocage réseau des domaines publicitaires.
- **SponsorBlock** : saute les passages non musicaux (catégories réglables).
- **Version bureau** (option) : charge l'interface desktop.

Réglages : appui long sur l'icône de l'appli puis **Réglages**.
La connexion Google se fait dans l'appli, comme sur le site.

### Compiler

Prérequis : JDK 17+ et le SDK Android (`ANDROID_HOME` ou `android/local.properties` avec `sdk.dir=...`).

```sh
cd mobile/android
./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

**Signature** : `android/keystore.properties` + `android/pear-release.jks` (jamais commités).
Sans eux, l'APK est signé avec la clé de debug. **Sauvegarde le `.jks` et son mot de passe** :
sans la même clé, Android refusera d'installer une mise à jour par-dessus l'ancienne version.

La CI GitHub (`.github/workflows/android.yml`) compile aussi l'APK à chaque push sur `mobile/android/`.
Pour qu'elle signe avec ta clé, ajoute ces secrets au dépôt :

```sh
gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -w0 mobile/android/pear-release.jks)
gh secret set ANDROID_KEYSTORE_PASSWORD   # valeur de storePassword dans keystore.properties
```

## 2. PWA télécommande (`remote/`)

HTML/CSS/JS statique, sans build. Fonctions : lecture/pause, précédent/suivant, seek, volume, mute,
like/dislike, aléatoire, répétition, file d'attente (sauter à un titre, retirer, vider), recherche
(lire maintenant / ajouter à la file). Mises à jour en temps réel par WebSocket. Installable
(« Ajouter à l'écran d'accueil »).

### Côté PC

Pear Desktop → **Plugins → API Server** : activer, port `26538`, hostname `0.0.0.0`,
stratégie d'auth **AUTH_AT_FIRST** (recommandé). À la première connexion d'un appareil, une fenêtre
s'ouvre sur le PC pour autoriser ou refuser.

### Pourquoi passer par le VPS

Une page en HTTPS (`https://pear.shinaki.cc`) ne peut pas appeler une API en HTTP sur le réseau local
(contenu mixte bloqué par le navigateur). Nginx sert donc la PWA **et** relaie `/api` et `/auth`
vers le PC, sur la même origine HTTPS.

Le VPS doit pouvoir joindre le PC. Le plus simple : **Tailscale** (gratuit) sur le PC et sur le VPS.

```sh
# sur le VPS et sur le PC (Windows : installeur sur tailscale.com)
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
tailscale ip -4    # sur le PC -> 100.x.y.z, à mettre dans nginx-pear.conf
```

> Sous WSL, Pear Desktop tourne normalement côté Windows : installe Tailscale sous Windows et
> autorise le port 26538 dans le pare-feu Windows pour l'interface Tailscale.

### Déploiement sur le VPS

1. DNS : un enregistrement `A` `pear.shinaki.cc` vers l'IP du VPS.
2. Nginx : copie `deploy/nginx-pear.conf` dans `/etc/nginx/sites-available/pear`, mets l'IP Tailscale
   du PC dans `upstream`, active le site, puis `sudo nginx -t && sudo systemctl reload nginx`.
3. HTTPS : `sudo certbot --nginx -d pear.shinaki.cc` (requis pour l'installation en PWA).
4. Fichiers : `mobile/deploy/deploy.sh user@vps` compile l'APK et envoie `remote/` + `pear-mobile.apk`
   dans `/var/www/pear`. La page de connexion affiche alors un lien de téléchargement de l'APK.

Ensuite, sur le téléphone : ouvrir `https://pear.shinaki.cc`, se connecter (adresse pré-remplie),
valider sur le PC, puis « Ajouter à l'écran d'accueil ».

### Sans VPS (réseau local uniquement)

Sers `remote/` en HTTP sur le LAN (ex. `npx serve mobile/remote`) et entre `http://IP-du-PC:26538`
comme adresse du serveur. L'API autorise le CORS. Ça marche sans HTTPS, mais sans installation PWA.

## Sécurité

- Garde **AUTH_AT_FIRST** : avec `NONE`, n'importe qui connaissant l'URL contrôlerait ta musique.
- Les appareils autorisés sont listés dans la config du plugin (`authorizedClients`) : retire-les
  pour révoquer un accès.
