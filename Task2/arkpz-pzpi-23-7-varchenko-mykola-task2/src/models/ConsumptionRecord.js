import { DataTypes } from 'sequelize'
import { sequelize } from '../config/db.js'

export const ConsumptionRecord = sequelize.define('ConsumptionRecord', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  appliance_id: { type: DataTypes.INTEGER, allowNull: true },

  consumption_kwh: { type: DataTypes.DECIMAL(10, 3), allowNull: false },
  applied_price_per_kwh: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
  cost: { type: DataTypes.DECIMAL(12, 4), allowNull: false },

  record_date: { type: DataTypes.DATEONLY, allowNull: false },
  notes: { type: DataTypes.STRING(500), allowNull: true },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'consumption_records',
  timestamps: false
})
