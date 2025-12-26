import { DataTypes } from 'sequelize'
import { sequelize } from '../config/db.js'

export const Tariff = sequelize.define('Tariff', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  price_per_kwh: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
  tariff_name: { type: DataTypes.STRING(120), allowNull: false },
  valid_from: { type: DataTypes.DATEONLY, allowNull: false },
  valid_to: { type: DataTypes.DATEONLY, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'tariffs',
  timestamps: false
})
