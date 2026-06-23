// i18n.js — localization for TUX SMASH ROYALE.
// Exactly one global: window.I18n.
//
// Languages: English (default), Deutsch, Francais, Portugues, Letzebuergesch.
// The product name "Tux Smash Royale" and the "Activate Windows" gag text are
// NEVER translated (kept verbatim in English in every language).
//
// API (pinned by the project contract; other modules depend on these):
//   I18n.LANGS          -> [{code,name}, ...] with properly accented display names
//   I18n.init()         -> load saved language code from localStorage 'clobi.lang'
//   I18n.hasChosen()    -> bool, whether the user has explicitly picked a language
//   I18n.get()          -> current language code (default 'en')
//   I18n.set(code)      -> persist choice + fire onChange listeners
//   I18n.onChange(fn)   -> register a change listener (called with the new code)
//   I18n.t(key, en)     -> translated string for current language, falling back
//                          to the provided English string if key/lang missing
//   I18n.STRINGS        -> { en:{...}, de:{...}, fr:{...}, pt:{...}, lb:{...} }

(function () {
  'use strict';

  var STORAGE_KEY = 'clobi.lang';
  var DEFAULT_LANG = 'en';

  var LANGS = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'pt', name: 'Português' },
    { code: 'lb', name: 'Lëtzebuergesch' }
  ];

  // ---- Translation tables -------------------------------------------------
  // Every key listed in the project's STRING KEYS appears in every language.
  // Translations are natural, accurate and kid-friendly. Luxembourgish is
  // authentic Lëtzebuergesch.

  var STRINGS = {
    // ===================== ENGLISH (source of truth) =====================
    en: {
      'app.tagline': 'Honor the penguin. Smash the rest.',

      'nav.play': 'Play',
      'nav.editChar': 'Edit Character',
      'nav.signIn': 'Sign in',
      'nav.signOut': 'Sign out',
      'nav.language': 'Language',

      'lang.choose': 'Choose your language',

      'menu.nickname': 'Nickname',
      'menu.nicknamePh': 'Enter your name',
      'menu.rooms': 'Rooms',
      'menu.createRoom': 'Create Room',
      'menu.roomName': 'Room name',
      'menu.password': 'Password',
      'menu.passwordOpt': 'Password (optional)',
      'menu.maxPlayers': 'Max players',
      'menu.mode': 'Mode',
      'menu.join': 'Join',
      'menu.locked': 'Locked',
      'menu.noRooms': 'No rooms yet. Create one!',
      'menu.refresh': 'Refresh',

      'mode.smash': 'Tux Smash',
      'mode.smashDesc': 'Shove your rivals off the platform into the void!',
      'mode.royale': 'Distro Royale',
      'mode.royaleDesc': 'Survive the shrinking Menthol Zone. Last one standing wins!',

      'lobby.players': 'Players',
      'lobby.ready': 'Ready',
      'lobby.notReady': 'Not ready',
      'lobby.start': 'Start',
      'lobby.waitingHost': 'Waiting for the host to start…',
      'lobby.leave': 'Leave',

      'editor.title': 'Character Editor',
      'editor.bodyType': 'Body type',
      'editor.tux': 'Tux',
      'editor.humanoid': 'Humanoid',
      'editor.body': 'Body',
      'editor.belly': 'Belly',
      'editor.feet': 'Feet',
      'editor.hat': 'Hat',
      'editor.eyes': 'Eyes',
      'editor.eyebrows': 'Eyebrows',
      'editor.mouth': 'Mouth',
      'editor.accessory': 'Accessory',
      'editor.cape': 'Cape',
      'editor.name': 'Name',
      'editor.random': 'Randomize',
      'editor.reset': 'Reset',
      'editor.save': 'Save',
      'editor.saved': 'Saved!',
      'editor.skin': 'Skin',
      'editor.hairColor': 'Hair',
      'editor.beardColor': 'Beard',
      'editor.beard': 'Beard',
      'editor.shirt': 'Shirt',
      'editor.pants': 'Pants',
      'editor.shoes': 'Shoes',
      'editor.hairstyle': 'Hairstyle',
      'editor.shirtStyle': 'Shirt',
      'editor.pantsStyle': 'Pants',
      'editor.shoeStyle': 'Shoes',
      'editor.capeColor': 'Cape',
      'editor.gender': 'Gender',
      'editor.male': 'Male',
      'editor.female': 'Female',
      'editor.build': 'Build',
      'editor.thin': 'Thin',
      'editor.fat': 'Fat',
      'editor.zoom': 'Zoom',
      'editor.flip': 'Flip',
      'editor.colors': 'Colours',
      'editor.styles': 'Styles',
      'editor.custom': 'CUSTOM',
      'editor.pickColor': 'Pick any colour',
      'editor.presets': 'Presets',
      'editor.load': 'Load',
      'editor.savePreset': 'Save',
      'editor.delete': 'Del',
      'editor.noPresets': '— none —',
      'editor.presetName': 'Preset name:',
      'editor.presetSaved': 'Preset saved.',
      'editor.presetLoaded': 'Preset loaded.',
      'editor.presetDeleted': 'Preset deleted.',
      'editor.randomized': 'Randomized.',
      'editor.resetDone': 'Reset to classic Tux.',
      'editor.none': 'None',
      'editor.namePh': 'TUX',
      'editor.savedSynced': 'Saved and synced to your account.',
      'editor.savedLocal': 'Saved locally (sync failed).',

      'account.signIn': 'Sign in',
      'account.signUp': 'Sign up',
      'account.username': 'Username',
      'account.password': 'Password',
      'account.login': 'Log in',
      'account.register': 'Register',
      'account.logout': 'Log out',
      'account.loggedInAs': 'Signed in as',
      'account.error': 'Wrong username or password.',
      'account.cloudHint': 'Sign in to save your character in the cloud.',

      'game.damage': 'Damage',
      'game.hp': 'HP',
      'game.alive': 'Alive',
      'game.zone': 'Zone',
      'game.youWin': 'You win!',
      'game.youLose': 'You lose!',
      'game.winnerIs': 'Winner:',
      'game.eliminated': 'Eliminated!',
      'game.backToMenu': 'Back to menu',
      'game.countdown': 'Get ready…',

      'controls.title': 'Controls',
      'controls.move': 'Move',
      'controls.attack': 'Belly bash',
      'controls.throw': 'Throw LibreOffice',
      'controls.dash': 'Dash',
      'controls.vim': 'Vim command (/)',

      'common.ok': 'OK',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.back': 'Back',
      'common.create': 'Create'
    },

    // ========================== DEUTSCH ==========================
    de: {
      'app.tagline': 'Ehre den Pinguin. Schubs den Rest.',

      'nav.play': 'Spielen',
      'nav.editChar': 'Charakter bearbeiten',
      'nav.signIn': 'Anmelden',
      'nav.signOut': 'Abmelden',
      'nav.language': 'Sprache',

      'lang.choose': 'Wähle deine Sprache',

      'menu.nickname': 'Spitzname',
      'menu.nicknamePh': 'Gib deinen Namen ein',
      'menu.rooms': 'Räume',
      'menu.createRoom': 'Raum erstellen',
      'menu.roomName': 'Raumname',
      'menu.password': 'Passwort',
      'menu.passwordOpt': 'Passwort (optional)',
      'menu.maxPlayers': 'Max. Spieler',
      'menu.mode': 'Modus',
      'menu.join': 'Beitreten',
      'menu.locked': 'Gesperrt',
      'menu.noRooms': 'Noch keine Räume. Erstell einen!',
      'menu.refresh': 'Aktualisieren',

      'mode.smash': 'Tux Smash',
      'mode.smashDesc': 'Schubs deine Gegner von der Plattform ins Leere!',
      'mode.royale': 'Distro Royale',
      'mode.royaleDesc': 'Überlebe die schrumpfende Menthol-Zone. Der Letzte gewinnt!',

      'lobby.players': 'Spieler',
      'lobby.ready': 'Bereit',
      'lobby.notReady': 'Nicht bereit',
      'lobby.start': 'Start',
      'lobby.waitingHost': 'Warte auf den Host zum Starten…',
      'lobby.leave': 'Verlassen',

      'editor.title': 'Charakter-Editor',
      'editor.bodyType': 'Körpertyp',
      'editor.tux': 'Tux',
      'editor.humanoid': 'Mensch',
      'editor.body': 'Körper',
      'editor.belly': 'Bauch',
      'editor.feet': 'Füße',
      'editor.hat': 'Hut',
      'editor.eyes': 'Augen',
      'editor.eyebrows': 'Augenbrauen',
      'editor.mouth': 'Mund',
      'editor.accessory': 'Accessoire',
      'editor.cape': 'Umhang',
      'editor.name': 'Name',
      'editor.random': 'Zufällig',
      'editor.reset': 'Zurücksetzen',
      'editor.save': 'Speichern',
      'editor.saved': 'Gespeichert!',
      'editor.skin': 'Haut',
      'editor.hairColor': 'Haare',
      'editor.beardColor': 'Bart',
      'editor.beard': 'Bart',
      'editor.shirt': 'Hemd',
      'editor.pants': 'Hose',
      'editor.shoes': 'Schuhe',
      'editor.hairstyle': 'Frisur',
      'editor.shirtStyle': 'Hemd',
      'editor.pantsStyle': 'Hose',
      'editor.shoeStyle': 'Schuhe',
      'editor.capeColor': 'Umhang',
      'editor.gender': 'Geschlecht',
      'editor.male': 'Männlich',
      'editor.female': 'Weiblich',
      'editor.build': 'Statur',
      'editor.thin': 'Dünn',
      'editor.fat': 'Dick',
      'editor.zoom': 'Zoom',
      'editor.flip': 'Drehen',
      'editor.colors': 'Farben',
      'editor.styles': 'Stile',
      'editor.custom': 'EIGENE',
      'editor.pickColor': 'Beliebige Farbe wählen',
      'editor.presets': 'Vorlagen',
      'editor.load': 'Laden',
      'editor.savePreset': 'Speichern',
      'editor.delete': 'Lösch',
      'editor.noPresets': '— keine —',
      'editor.presetName': 'Name der Vorlage:',
      'editor.presetSaved': 'Vorlage gespeichert.',
      'editor.presetLoaded': 'Vorlage geladen.',
      'editor.presetDeleted': 'Vorlage gelöscht.',
      'editor.randomized': 'Zufällig erzeugt.',
      'editor.resetDone': 'Auf klassischen Tux zurückgesetzt.',
      'editor.none': 'Keins',
      'editor.namePh': 'TUX',
      'editor.savedSynced': 'Gespeichert und mit deinem Konto synchronisiert.',
      'editor.savedLocal': 'Lokal gespeichert (Sync fehlgeschlagen).',

      'account.signIn': 'Anmelden',
      'account.signUp': 'Registrieren',
      'account.username': 'Benutzername',
      'account.password': 'Passwort',
      'account.login': 'Einloggen',
      'account.register': 'Registrieren',
      'account.logout': 'Ausloggen',
      'account.loggedInAs': 'Angemeldet als',
      'account.error': 'Falscher Benutzername oder Passwort.',
      'account.cloudHint': 'Melde dich an, um deinen Charakter in der Cloud zu speichern.',

      'game.damage': 'Schaden',
      'game.hp': 'LP',
      'game.alive': 'Am Leben',
      'game.zone': 'Zone',
      'game.youWin': 'Du gewinnst!',
      'game.youLose': 'Du verlierst!',
      'game.winnerIs': 'Sieger:',
      'game.eliminated': 'Ausgeschieden!',
      'game.backToMenu': 'Zurück zum Menü',
      'game.countdown': 'Mach dich bereit…',

      'controls.title': 'Steuerung',
      'controls.move': 'Bewegen',
      'controls.attack': 'Bauch-Stoß',
      'controls.throw': 'LibreOffice werfen',
      'controls.dash': 'Sprint',
      'controls.vim': 'Vim-Befehl (/)',

      'common.ok': 'OK',
      'common.cancel': 'Abbrechen',
      'common.close': 'Schließen',
      'common.back': 'Zurück',
      'common.create': 'Erstellen'
    },

    // ========================== FRANÇAIS ==========================
    fr: {
      'app.tagline': 'Honore le manchot. Dégage les autres.',

      'nav.play': 'Jouer',
      'nav.editChar': 'Modifier le personnage',
      'nav.signIn': 'Se connecter',
      'nav.signOut': 'Se déconnecter',
      'nav.language': 'Langue',

      'lang.choose': 'Choisis ta langue',

      'menu.nickname': 'Pseudo',
      'menu.nicknamePh': 'Entre ton nom',
      'menu.rooms': 'Salons',
      'menu.createRoom': 'Créer un salon',
      'menu.roomName': 'Nom du salon',
      'menu.password': 'Mot de passe',
      'menu.passwordOpt': 'Mot de passe (optionnel)',
      'menu.maxPlayers': 'Joueurs max',
      'menu.mode': 'Mode',
      'menu.join': 'Rejoindre',
      'menu.locked': 'Verrouillé',
      'menu.noRooms': 'Aucun salon pour le moment. Crées-en un !',
      'menu.refresh': 'Actualiser',

      'mode.smash': 'Tux Smash',
      'mode.smashDesc': 'Pousse tes rivaux hors de la plateforme dans le vide !',
      'mode.royale': 'Distro Royale',
      'mode.royaleDesc': 'Survis à la Zone Menthol qui rétrécit. Le dernier gagne !',

      'lobby.players': 'Joueurs',
      'lobby.ready': 'Prêt',
      'lobby.notReady': 'Pas prêt',
      'lobby.start': 'Démarrer',
      'lobby.waitingHost': 'En attente de l’hôte pour démarrer…',
      'lobby.leave': 'Quitter',

      'editor.title': 'Éditeur de personnage',
      'editor.bodyType': 'Type de corps',
      'editor.tux': 'Tux',
      'editor.humanoid': 'Humain',
      'editor.body': 'Corps',
      'editor.belly': 'Ventre',
      'editor.feet': 'Pieds',
      'editor.hat': 'Chapeau',
      'editor.eyes': 'Yeux',
      'editor.eyebrows': 'Sourcils',
      'editor.mouth': 'Bouche',
      'editor.accessory': 'Accessoire',
      'editor.cape': 'Cape',
      'editor.name': 'Nom',
      'editor.random': 'Au hasard',
      'editor.reset': 'Réinitialiser',
      'editor.save': 'Enregistrer',
      'editor.saved': 'Enregistré !',
      'editor.skin': 'Peau',
      'editor.hairColor': 'Cheveux',
      'editor.beardColor': 'Barbe',
      'editor.beard': 'Barbe',
      'editor.shirt': 'Haut',
      'editor.pants': 'Pantalon',
      'editor.shoes': 'Chaussures',
      'editor.hairstyle': 'Coiffure',
      'editor.shirtStyle': 'Haut',
      'editor.pantsStyle': 'Pantalon',
      'editor.shoeStyle': 'Chaussures',
      'editor.capeColor': 'Cape',
      'editor.gender': 'Genre',
      'editor.male': 'Homme',
      'editor.female': 'Femme',
      'editor.build': 'Carrure',
      'editor.thin': 'Mince',
      'editor.fat': 'Gros',
      'editor.zoom': 'Zoom',
      'editor.flip': 'Retourner',
      'editor.colors': 'Couleurs',
      'editor.styles': 'Styles',
      'editor.custom': 'PERSO',
      'editor.pickColor': 'Choisir une couleur',
      'editor.presets': 'Préréglages',
      'editor.load': 'Charger',
      'editor.savePreset': 'Enreg.',
      'editor.delete': 'Suppr',
      'editor.noPresets': '— aucun —',
      'editor.presetName': 'Nom du préréglage :',
      'editor.presetSaved': 'Préréglage enregistré.',
      'editor.presetLoaded': 'Préréglage chargé.',
      'editor.presetDeleted': 'Préréglage supprimé.',
      'editor.randomized': 'Au hasard.',
      'editor.resetDone': 'Retour au Tux classique.',
      'editor.none': 'Aucun',
      'editor.namePh': 'TUX',
      'editor.savedSynced': 'Enregistré et synchronisé avec ton compte.',
      'editor.savedLocal': 'Enregistré localement (échec de synchro).',

      'account.signIn': 'Se connecter',
      'account.signUp': 'S’inscrire',
      'account.username': 'Nom d’utilisateur',
      'account.password': 'Mot de passe',
      'account.login': 'Connexion',
      'account.register': 'Inscription',
      'account.logout': 'Déconnexion',
      'account.loggedInAs': 'Connecté en tant que',
      'account.error': 'Nom d’utilisateur ou mot de passe incorrect.',
      'account.cloudHint': 'Connecte-toi pour sauvegarder ton personnage dans le cloud.',

      'game.damage': 'Dégâts',
      'game.hp': 'PV',
      'game.alive': 'En vie',
      'game.zone': 'Zone',
      'game.youWin': 'Tu as gagné !',
      'game.youLose': 'Tu as perdu !',
      'game.winnerIs': 'Gagnant :',
      'game.eliminated': 'Éliminé !',
      'game.backToMenu': 'Retour au menu',
      'game.countdown': 'Prépare-toi…',

      'controls.title': 'Commandes',
      'controls.move': 'Se déplacer',
      'controls.attack': 'Coup de ventre',
      'controls.throw': 'Lancer LibreOffice',
      'controls.dash': 'Foncer',
      'controls.vim': 'Commande Vim (/)',

      'common.ok': 'OK',
      'common.cancel': 'Annuler',
      'common.close': 'Fermer',
      'common.back': 'Retour',
      'common.create': 'Créer'
    },

    // ========================== PORTUGUÊS ==========================
    pt: {
      'app.tagline': 'Honra o pinguim. Empurra os outros.',

      'nav.play': 'Jogar',
      'nav.editChar': 'Editar personagem',
      'nav.signIn': 'Entrar',
      'nav.signOut': 'Sair',
      'nav.language': 'Idioma',

      'lang.choose': 'Escolhe o teu idioma',

      'menu.nickname': 'Apelido',
      'menu.nicknamePh': 'Escreve o teu nome',
      'menu.rooms': 'Salas',
      'menu.createRoom': 'Criar sala',
      'menu.roomName': 'Nome da sala',
      'menu.password': 'Palavra-passe',
      'menu.passwordOpt': 'Palavra-passe (opcional)',
      'menu.maxPlayers': 'Máx. jogadores',
      'menu.mode': 'Modo',
      'menu.join': 'Entrar',
      'menu.locked': 'Bloqueada',
      'menu.noRooms': 'Ainda não há salas. Cria uma!',
      'menu.refresh': 'Atualizar',

      'mode.smash': 'Tux Smash',
      'mode.smashDesc': 'Empurra os teus rivais da plataforma para o vazio!',
      'mode.royale': 'Distro Royale',
      'mode.royaleDesc': 'Sobrevive à Zona Mentol que encolhe. O último a ficar vence!',

      'lobby.players': 'Jogadores',
      'lobby.ready': 'Pronto',
      'lobby.notReady': 'Não pronto',
      'lobby.start': 'Começar',
      'lobby.waitingHost': 'À espera que o anfitrião comece…',
      'lobby.leave': 'Sair',

      'editor.title': 'Editor de personagem',
      'editor.bodyType': 'Tipo de corpo',
      'editor.tux': 'Tux',
      'editor.humanoid': 'Humano',
      'editor.body': 'Corpo',
      'editor.belly': 'Barriga',
      'editor.feet': 'Pés',
      'editor.hat': 'Chapéu',
      'editor.eyes': 'Olhos',
      'editor.eyebrows': 'Sobrancelhas',
      'editor.mouth': 'Boca',
      'editor.accessory': 'Acessório',
      'editor.cape': 'Capa',
      'editor.name': 'Nome',
      'editor.random': 'Aleatório',
      'editor.reset': 'Repor',
      'editor.save': 'Guardar',
      'editor.saved': 'Guardado!',
      'editor.skin': 'Pele',
      'editor.hairColor': 'Cabelo',
      'editor.beardColor': 'Barba',
      'editor.beard': 'Barba',
      'editor.shirt': 'Camisa',
      'editor.pants': 'Calças',
      'editor.shoes': 'Sapatos',
      'editor.hairstyle': 'Penteado',
      'editor.shirtStyle': 'Camisa',
      'editor.pantsStyle': 'Calças',
      'editor.shoeStyle': 'Sapatos',
      'editor.capeColor': 'Capa',
      'editor.gender': 'Género',
      'editor.male': 'Masculino',
      'editor.female': 'Feminino',
      'editor.build': 'Constituição',
      'editor.thin': 'Magro',
      'editor.fat': 'Gordo',
      'editor.zoom': 'Zoom',
      'editor.flip': 'Virar',
      'editor.colors': 'Cores',
      'editor.styles': 'Estilos',
      'editor.custom': 'PERSON.',
      'editor.pickColor': 'Escolher qualquer cor',
      'editor.presets': 'Predefinições',
      'editor.load': 'Carregar',
      'editor.savePreset': 'Guardar',
      'editor.delete': 'Apag',
      'editor.noPresets': '— nenhuma —',
      'editor.presetName': 'Nome da predefinição:',
      'editor.presetSaved': 'Predefinição guardada.',
      'editor.presetLoaded': 'Predefinição carregada.',
      'editor.presetDeleted': 'Predefinição apagada.',
      'editor.randomized': 'Aleatório.',
      'editor.resetDone': 'Reposto para o Tux clássico.',
      'editor.none': 'Nenhum',
      'editor.namePh': 'TUX',
      'editor.savedSynced': 'Guardado e sincronizado com a tua conta.',
      'editor.savedLocal': 'Guardado localmente (falha na sincronização).',

      'account.signIn': 'Entrar',
      'account.signUp': 'Registar',
      'account.username': 'Nome de utilizador',
      'account.password': 'Palavra-passe',
      'account.login': 'Iniciar sessão',
      'account.register': 'Registar',
      'account.logout': 'Terminar sessão',
      'account.loggedInAs': 'Sessão iniciada como',
      'account.error': 'Nome de utilizador ou palavra-passe incorretos.',
      'account.cloudHint': 'Inicia sessão para guardar o teu personagem na nuvem.',

      'game.damage': 'Dano',
      'game.hp': 'PV',
      'game.alive': 'Vivos',
      'game.zone': 'Zona',
      'game.youWin': 'Ganhaste!',
      'game.youLose': 'Perdeste!',
      'game.winnerIs': 'Vencedor:',
      'game.eliminated': 'Eliminado!',
      'game.backToMenu': 'Voltar ao menu',
      'game.countdown': 'Prepara-te…',

      'controls.title': 'Controlos',
      'controls.move': 'Mover',
      'controls.attack': 'Barrigada',
      'controls.throw': 'Atirar LibreOffice',
      'controls.dash': 'Investida',
      'controls.vim': 'Comando Vim (/)',

      'common.ok': 'OK',
      'common.cancel': 'Cancelar',
      'common.close': 'Fechar',
      'common.back': 'Voltar',
      'common.create': 'Criar'
    },

    // ======================= LËTZEBUERGESCH =======================
    lb: {
      'app.tagline': 'Éiert de Pinguin. Schéisst de Rescht eraus.',

      'nav.play': 'Spillen',
      'nav.editChar': 'Personnage änneren',
      'nav.signIn': 'Umellen',
      'nav.signOut': 'Ofmellen',
      'nav.language': 'Sprooch',

      'lang.choose': 'Wiel deng Sprooch',

      'menu.nickname': 'Spëtznumm',
      'menu.nicknamePh': 'Gëff däin Numm an',
      'menu.rooms': 'Raim',
      'menu.createRoom': 'Raum erstellen',
      'menu.roomName': 'Numm vum Raum',
      'menu.password': 'Passwuert',
      'menu.passwordOpt': 'Passwuert (fakultativ)',
      'menu.maxPlayers': 'Max. Spiller',
      'menu.mode': 'Modus',
      'menu.join': 'Bäitrieden',
      'menu.locked': 'Gespaart',
      'menu.noRooms': 'Nach keng Raim. Maach een!',
      'menu.refresh': 'Aktualiséieren',

      'mode.smash': 'Tux Smash',
      'mode.smashDesc': 'Schéiss deng Géigner vun der Plattform an d’Eidelt!',
      'mode.royale': 'Distro Royale',
      'mode.royaleDesc': 'Iwwerlief déi méi kleng ginn Menthol-Zone. De Leschten gewënnt!',

      'lobby.players': 'Spiller',
      'lobby.ready': 'Prett',
      'lobby.notReady': 'Net prett',
      'lobby.start': 'Start',
      'lobby.waitingHost': 'Waart op den Host fir unzefänken…',
      'lobby.leave': 'Verloossen',

      'editor.title': 'Personnage-Editeur',
      'editor.bodyType': 'Kierpertyp',
      'editor.tux': 'Tux',
      'editor.humanoid': 'Mënsch',
      'editor.body': 'Kierper',
      'editor.belly': 'Bauch',
      'editor.feet': 'Féiss',
      'editor.hat': 'Hutt',
      'editor.eyes': 'Aen',
      'editor.eyebrows': 'Aenbrauen',
      'editor.mouth': 'Mond',
      'editor.accessory': 'Accessoire',
      'editor.cape': 'Ëmhang',
      'editor.name': 'Numm',
      'editor.random': 'Zoufälleg',
      'editor.reset': 'Zerécksetzen',
      'editor.save': 'Späicheren',
      'editor.saved': 'Gespäichert!',
      'editor.skin': 'Haut',
      'editor.hairColor': 'Hoer',
      'editor.beardColor': 'Baart',
      'editor.beard': 'Baart',
      'editor.shirt': 'Hiem',
      'editor.pants': 'Box',
      'editor.shoes': 'Schong',
      'editor.hairstyle': 'Frisur',
      'editor.shirtStyle': 'Hiem',
      'editor.pantsStyle': 'Box',
      'editor.shoeStyle': 'Schong',
      'editor.capeColor': 'Ëmhang',
      'editor.gender': 'Geschlecht',
      'editor.male': 'Männlech',
      'editor.female': 'Weiblech',
      'editor.build': 'Statur',
      'editor.thin': 'Dënn',
      'editor.fat': 'Déck',
      'editor.zoom': 'Zoom',
      'editor.flip': 'Dréinen',
      'editor.colors': 'Faarwen',
      'editor.styles': 'Stiler',
      'editor.custom': 'EEGEN',
      'editor.pickColor': 'Eng Faarf wielen',
      'editor.presets': 'Virlagen',
      'editor.load': 'Lueden',
      'editor.savePreset': 'Späicheren',
      'editor.delete': 'Läschen',
      'editor.noPresets': '— keng —',
      'editor.presetName': 'Numm vun der Virlag:',
      'editor.presetSaved': 'Virlag gespäichert.',
      'editor.presetLoaded': 'Virlag gelueden.',
      'editor.presetDeleted': 'Virlag geläscht.',
      'editor.randomized': 'Zoufälleg.',
      'editor.resetDone': 'Zréck op de klasseschen Tux.',
      'editor.none': 'Keen',
      'editor.namePh': 'TUX',
      'editor.savedSynced': 'Gespäichert a mat dengem Kont synchroniséiert.',
      'editor.savedLocal': 'Lokal gespäichert (Sync feelgeschloen).',

      'account.signIn': 'Umellen',
      'account.signUp': 'Registréieren',
      'account.username': 'Benotzernumm',
      'account.password': 'Passwuert',
      'account.login': 'Aloggen',
      'account.register': 'Registréieren',
      'account.logout': 'Ausloggen',
      'account.loggedInAs': 'Ugemellt als',
      'account.error': 'Falsche Benotzernumm oder Passwuert.',
      'account.cloudHint': 'Mell dech un fir däi Personnage an der Cloud ze späicheren.',

      'game.damage': 'Schued',
      'game.hp': 'LP',
      'game.alive': 'Lieweg',
      'game.zone': 'Zone',
      'game.youWin': 'Du gewënns!',
      'game.youLose': 'Du verléiers!',
      'game.winnerIs': 'Gewënner:',
      'game.eliminated': 'Eliminéiert!',
      'game.backToMenu': 'Zréck zum Menü',
      'game.countdown': 'Maach dech prett…',

      'controls.title': 'Steierung',
      'controls.move': 'Beweegen',
      'controls.attack': 'Bauchschlag',
      'controls.throw': 'LibreOffice geheien',
      'controls.dash': 'Spurt',
      'controls.vim': 'Vim-Kommando (/)',

      'common.ok': 'OK',
      'common.cancel': 'Ofbriechen',
      'common.close': 'Zoumaachen',
      'common.back': 'Zréck',
      'common.create': 'Erstellen'
    }
  };

  // ---- State --------------------------------------------------------------

  var current = DEFAULT_LANG;   // active language code
  var chosen = false;           // has the user explicitly picked one?
  var listeners = [];           // onChange callbacks

  function isValidCode(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === code) return true;
    }
    return false;
  }

  function readStorage() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(code) {
    try {
      window.localStorage.setItem(STORAGE_KEY, code);
    } catch (e) {
      // localStorage may be unavailable (private mode); fail silently.
    }
  }

  // ---- Public API ---------------------------------------------------------

  // init(): restore the saved language from localStorage. If a valid code is
  // stored, the user is considered to have already chosen. Otherwise we stay
  // on the English default and report hasChosen() === false so the app can
  // show the first-visit language popup.
  function init() {
    var saved = readStorage();
    if (saved && isValidCode(saved)) {
      current = saved;
      chosen = true;
    } else {
      current = DEFAULT_LANG;
      chosen = false;
    }
    return current;
  }

  function hasChosen() {
    return chosen;
  }

  function get() {
    return current;
  }

  // set(code): switch the active language, persist it, mark the choice as made,
  // and notify all onChange listeners. Invalid codes are ignored.
  function set(code) {
    if (!isValidCode(code)) return;
    var changed = code !== current || !chosen;
    current = code;
    chosen = true;
    writeStorage(code);
    if (changed) {
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](current);
        } catch (e) {
          // A misbehaving listener must not break the others.
        }
      }
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  // t(key, fallbackEn): return the translated string for the current language.
  // Falls back to the English table, then to the provided English fallback,
  // then to the key itself — so the UI never renders "undefined".
  function t(key, fallbackEn) {
    var table = STRINGS[current];
    if (table && Object.prototype.hasOwnProperty.call(table, key)) {
      return table[key];
    }
    var en = STRINGS.en;
    if (en && Object.prototype.hasOwnProperty.call(en, key)) {
      return en[key];
    }
    if (typeof fallbackEn === 'string') return fallbackEn;
    return key;
  }

  var I18n = {
    LANGS: LANGS,
    STRINGS: STRINGS,
    init: init,
    hasChosen: hasChosen,
    get: get,
    set: set,
    onChange: onChange,
    t: t
  };

  window.I18n = I18n;
})();
