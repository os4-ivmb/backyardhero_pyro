import { useState } from "react";
import axios from "axios";

const PROTOCOLS = ["BKYD_TS_HYBRID"]

export default function TxConfig() {
  const [rfSerialAddr, setRFSerialAddr] = useState("/dev/tty.usbmodem01");
  const [rfSerialBaud, setRFSerialBaud] = useState(115200);
  const [rfProtocol, setRFProtocol] = useState(PROTOCOLS[0]);

  const updateRFFrontend = async (evt) => {
    await axios.post(
      "/api/system/cmd_daemon",
      { type: "select_serial", device: rfSerialAddr, baud: rfSerialBaud, protocol: rfProtocol},
      {
        headers: {
          "Content-Type": "application/json",
        }
      }
    );
  };

  return (
    <div className="">
        <h2 className="text-lg">RF Frontend Settings</h2>
        <div className="flex flex-col gap-3">
            <label
                className="block text-gray-200 text-sm font-bold mb-2"
                htmlFor="protocol"
            >
                Protocol
            </label>
            <select
                value={rfProtocol}
                onChange={setRFProtocol}
                name="protocol"
                className="block appearance-none w-full border border-gray-400 hover:border-gray-500 px-4 py-2 pr-8 rounded shadow leading-tight focus:outline-none focus:shadow-outline"
            >
                {PROTOCOLS.map((k, i) => (
                <option key={i} value={k}>
                    {k}
                </option>
                ))}
            </select>
            <p className="text-gray-400 text-xs italic">
              Protocol to use to transmit (by default - If transmitters are used in shows the appropriate protocol for that transmitter is always used.).
            </p>
            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="serial_addr"
            >
              Serial Device Address
            </label>
            <input
              value={rfSerialAddr}
              onChange={(e)=>setRFSerialAddr(e.target.value)}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline"
              name="serial_addr"
              type="text"
            />
            <p className="text-gray-400 text-xs italic">
              RF Frontend address to use to transmit.
            </p>
  
            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="rf_serial_baud"
            >
              RF Serial BAUD Rate
            </label>
            <input
              value={rfSerialBaud}
              onChange={(e)=>setRFSerialBaud(parseInt(e.target.value))}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline"
              name="rf_serial_baud"
              type="number"
            />
            <p className="text-gray-400 text-xs italic">Baud rate for the serial interface to RF Frontend.</p>

            <div className="flex items-center justify-between">
                <button
                onClick={updateRFFrontend}
                className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                type="button"
                >
                  Update
                </button>
            </div>
        </div>
    </div>
  );
}
