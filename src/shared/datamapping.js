

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
  
  module.exports = {
    mapStatus,
  };  