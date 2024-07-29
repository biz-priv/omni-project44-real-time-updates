/*
* File: src\shared\datamapping.js
* Project: Omni-project44-real-time-updates
* Author: Bizcloud Experts
* Date: 2023-07-05
* Confidential and Proprietary
*/

async function mapStatus(validStatusCodes) {
  switch (validStatusCodes) {
    case 'APL':
      return {
        type: 'ARRIVED',
        stopNumber: 1
      };
    case 'TTC':
      return {
        type: 'LOADING',
        stopNumber: 1
      };
    case 'COB':
      return {
        type: 'DEPARTED',
        stopNumber: 1
      };
    case 'PUP':
      return {
        type: 'DEPARTED',
        stopNumber: 1
      };
    case 'AAD':
      return {
        type: 'UNLOADING',
        stopNumber: 2
      };
    case 'DEL':
      return {
        type: 'DELIVERED',
        stopNumber: 2
      };
    case 'CAN':
      return {
        type: 'CANCELLED',
        stopNumber: 2
      };
    default:
      throw new Error(`Invalid status code: ${validStatusCodes}`);
  }
}


async function mapStatusfunc(validStatusCodes) {
  switch (validStatusCodes) {
    case 'PUP':
      return {
        eventType: 'PICKED_UP',
        stopType: 'ORIGIN',
        stopNumber: 0
      };
    case 'AHO':
      return {
        eventType: 'ARRIVED_AT_TERMINAL',
        stopType: 'TERMINAL',
        stopNumber: 0
      };
    case 'DOH':
      return {
        eventType: 'DEPARTED_TERMINAL',
        stopType: 'TERMINAL',
        stopNumber: 0
      };
    case 'ADH':
      return {
        eventType: 'ARRIVED_AT_TERMINAL',
        stopType: 'TERMINAL',
        stopNumber: 1
      };
    case 'DDH':
      return {
        eventType: 'DEPARTED_TERMINAL',
        stopType: 'TERMINAL',
        stopNumber: 1
      };
    case 'OFD':
      return {
        eventType: 'OUT_FOR_DELIVERY',
        stopType: 'DESTINATION',
        stopNumber: 1
      };
    case 'DEL':
      return {
        eventType: 'DELIVERED',
        stopType: 'DESTINATION',
        stopNumber: 1
      };
    default:
      throw new Error(`Invalid status code: ${validStatusCodes}`);
  }
}

module.exports = {
  mapStatus,
  mapStatusfunc
};  