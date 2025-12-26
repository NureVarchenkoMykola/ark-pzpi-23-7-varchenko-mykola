import { DataTypes } from 'sequelize'
import { sequelize } from '../config/db.js'

export const Appliance = sequelize.define('Appliance', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.STRING(120), allowNull: false },
  description: { type: DataTypes.STRING(500) },
  estimated_power: { type: DataTypes.DECIMAL(10, 3) },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'appliances',
  timestamps: false
})
