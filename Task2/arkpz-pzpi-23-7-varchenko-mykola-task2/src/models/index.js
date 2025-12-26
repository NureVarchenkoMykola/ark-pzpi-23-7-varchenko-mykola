import { sequelize } from '../config/db.js'
import { User } from './User.js'
import { Appliance } from './Appliance.js'
import { Tariff } from './Tariff.js'
import { ConsumptionRecord } from './ConsumptionRecord.js'
import { Limit } from './Limit.js'

export { sequelize, User, Appliance, Tariff, ConsumptionRecord, Limit }
