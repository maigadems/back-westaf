-- À importer via phpMyAdmin (Hostinger) dans votre base MySQL
CREATE TABLE IF NOT EXISTS reservations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  nom VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  telephone VARCHAR(50) NOT NULL,
  message TEXT,
  date_reservation DATE NOT NULL,
  creneaux TEXT NULL,                      -- tableau JSON de créneaux
  duree_heures INT NULL,
  montant_total INT NOT NULL,
  type_paiement ENUM('partiel','total') NOT NULL DEFAULT 'total',
  montant_paye INT NOT NULL DEFAULT 0,
  statut ENUM('en_attente','confirmee','annulee') NOT NULL DEFAULT 'confirmee',
  type_service ENUM('horaire','mixage','mastering') NOT NULL,
  nombre_titres INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_date (date_reservation),
  INDEX idx_dup (email, date_reservation, type_service)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Base déjà créée ? Exécuter une seule fois :
-- ALTER TABLE reservations ADD COLUMN type_paiement ENUM('partiel','total') NOT NULL DEFAULT 'total' AFTER montant_total, ADD COLUMN montant_paye INT NOT NULL DEFAULT 0 AFTER type_paiement;
-- UPDATE reservations SET montant_paye = montant_total WHERE montant_paye = 0;

-- Comptes clients (créés automatiquement après paiement)
CREATE TABLE IF NOT EXISTS clients (
  telephone VARCHAR(20) NOT NULL PRIMARY KEY,   -- 9 chiffres, sans indicatif
  nom VARCHAR(255) NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mot de passe initial, affiché une seule fois puis supprimé (24 h max)
CREATE TABLE IF NOT EXISTS credential_reveals (
  reveal_key VARCHAR(64) NOT NULL PRIMARY KEY,
  telephone VARCHAR(20) NOT NULL,
  password_plain VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
