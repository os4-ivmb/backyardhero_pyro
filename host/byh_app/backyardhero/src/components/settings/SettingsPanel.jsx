import BrightnessSlider from "./BrightnessSlider";
import TransmitRepetitionCount from "./TransmitRepetitionCount";
import TxConfig from "./TxConfig";
import DaemonSettings from "./DaemonSettings";
import ProtocolConfig from "./ProtocolConfig";

export default function SettingsPanel(props) {
  return (
    <div className="flex flex-col justify-center items-center gap-8 my-8 max-w-lg mx-auto bg-gray-800 shadow-md rounded-lg p-8">
      <h2 className="text-2xl font-bold text-white">Settings</h2>

      <div className="w-full">
        <BrightnessSlider />
      </div>

      <div className="w-full border-b pb-6 border-gray-500">
        <TransmitRepetitionCount />
      </div>
      <div className="w-full border-b pb-6 border-gray-500">
        <TxConfig/>    
      </div>
      <div className="w-full border-b pb-6 border-gray-500">
        <DaemonSettings />
      </div>
      <div className="w-full">
        <ProtocolConfig />
      </div>
    </div>
  );
}