
function mapStatus(validStatusCodes) {
    switch (validStatusCodes) {
        case 'APL':
            return {
                type: 'ARRIVED',
                StopNumber: 1
            };
        case 'TTC':
            return {
                type: 'LOADING',
                StopNumber: 1
            };
        case 'COB':
            return {
                type: 'DEPARTED',
                StopNumber: 1
            };
        case 'AAD':
            return {
                type: 'UNLOADING',
                StopNumber: 2
            };
        case 'DEL':
            return {
                type: 'DELIVERED',
                StopNumber: 2
            };
        case 'CAN':
            return {
                type: 'CANCELLED',
                StopNumber: 2
            };
        default:
            return null;
    }
}

module.exports = {
    mapStatus,
};