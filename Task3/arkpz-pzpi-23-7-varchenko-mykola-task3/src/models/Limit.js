import { DataTypes } from 'sequelize'
import { sequelize } from '../config/db.js'

export const Limit = sequelize.define('Limit', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },

  limit_kwh: { type: DataTypes.DECIMAL(10, 3), allowNull: false },

  period_type: { type: DataTypes.ENUM('week', 'month', 'year', 'custom'), allowNull: false },
  period_start: { type: DataTypes.DATEONLY, allowNull: false },
  period_end: { type: DataTypes.DATEONLY, allowNull: false },

  alert_enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
  alert_threshold_percent: { type: DataTypes.INTEGER, defaultValue: 80 },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'limits',
  timestamps: false
})
