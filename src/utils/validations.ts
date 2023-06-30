export function isNumeric(str: string) {
    if (typeof str != "string") return false // only process
    return !isNaN(+str) &&
           !isNaN(parseFloat(str)) // ensure strings of whitespace or \n fail
  }
  