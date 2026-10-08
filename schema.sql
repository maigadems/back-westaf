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
  statut ENUM('en_attente','confirmee','annulee') NOT NULL DEFAULT 'confirmee',
  type_service ENUM('horaire','mixage','mastering') NOT NULL,
  nombre_titres INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_date (date_reservation),
  INDEX idx_dup (email, date_reservation, type_service)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
